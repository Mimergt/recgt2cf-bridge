# Project Memory: GHL-Recurrente Bridge (EPICPay1)

Este documento sirve como memoria técnica y contexto para agentes de IA o desarrolladores que retomen este proyecto. Detalla el proceso de superación de bloqueos técnicos y el estado actual de la integración.

## 1. Objetivo del Proyecto
Crear un puente (Bridge) mediante **Cloudflare Workers** para integrar la pasarela de pagos **Recurrente** como un **Custom Payment Provider** en **GoHighLevel (GHL) API v2**.

## 2. El Gran Bloqueo: El Error 422 (Base Config Missing)
Durante gran parte del desarrollo, la API de GHL rechazó la conexión con un error `422: Base config for integration is not created yet`.

### Descubrimiento y Solución
- **Problema:** No se puede realizar un "Connect" (envío de llaves API) si GHL no ha inicializado primero el registro de la integración en la subcuenta.
- **Protocolo de 2 Pasos (Implementado en `src/index.ts`):**
  1. **POST `/payments/custom-provider/provider?locationId={id}`**: Registra los metadatos base (Nombre, URLs, Imagen). Esto crea la "Base Config".
  2. **POST `/payments/custom-provider/connect?locationId={id}`**: Registra las llaves de API (Live/Test).
- **Endpoint GET:** El endpoint correcto para verificar el estado es `GET /payments/custom-provider/connect?locationId={id}`. (Anteriormente se intentaba `/provider` lo cual devolvía 404).

## 3. Estado de la Aplicación en GHL App Studio
- **Nombre de la App:** Alpha EpicPay
- **Nombre del Provider:** `EPICPay1` (Debe coincidir exactamente en el código y en el Module).
- **Módulo Activo:** Payment Providers (One-Time habilitado).
- **Custom Page:** Se configuró una página personalizada para los detalles de la integración que apunta a la raíz del Worker.
- **Configuración 3/5:** Se determinó que NO es necesario llegar al 5/5 (Mandatory Steps/Review) para realizar pruebas privadas exitosas.

## 4. Arquitectura del Bridge (Cloudflare Worker)
- **OAuth Callback:** Maneja el intercambio de `code` por `accessToken` y extrae el `locationId`.
- **Registro Automático:** Al autorizar, el código ejecuta la secuencia de 2 pasos mencionada arriba para que el usuario no tenga que configurar nada manualmente en GHL.
- **Base de Datos (D1):** Tabla `tenants` guarda el `locationId` y el `accessToken` para uso futuro.
- **Manejo de Errores:** Incluye un bloque HTML de "Mega-Debug" que muestra la respuesta exacta de la API de GHL en caso de fallo.

## 5. Descubrimiento Crítico: Limitaciones de GHL Custom Payment Providers (11 Mar 2026)

### El Problema: No Hay Transmisión Automática de Datos al iframe
Después de extensas pruebas, se descubrió que **GHL Custom Payment Providers NO transmiten automáticamente los datos del cargo** (chargeId, amount, etc.) al iframe a través de ningún mecanismo:
- ❌ **URL Parameters**: GHL NO sustituye los placeholders (`{chargeId}`, `{amount}`, etc.)
- ❌ **PostMessage**: GHL NO envía eventos de postMessage con los datos de pago
- ❌ **sessionStorage/localStorage**: GHL NO almacena datos accesibles al iframe
- ❌ **Query Endpoint**: GHL NO llama al `/api/query` automáticamente

### La Solución Implementada: Formulario Manual Fallback + localStorage
1. El iframe ahora escucha postMessage y parámetros de URL por 10 segundos
2. Si no hay respuesta después de 10 segundos, **muestra un formulario manual**
3. El usuario completa: Factura, Monto, Email, Nombre
4. El `locationId` se obtiene en este orden:
   - Parámetro directamente en datos del formulario
   - localStorage (guardado desde OAuth callback)
   - sessionStorage
   - **Fallback: locationId conocido (`4jq4IBO2szzCj4eNcsvC`) para testing**
5. El formulario envía los datos al endpoint `/api/create-checkout`
6. Se genera el checkout de Recurrente y se redirige

### Código Modificado
- `src/ghl.ts` → `handlePaymentsUrl()`: Formulario manual con timeout (10s)
- `src/index.ts` → OAuth callback: Ahora guarda locationId en localStorage vía JavaScript
- Fallback locationId por defecto para testing

### Estado Actual
✅ **Formulario manual funciona**
✅ **Llamada a `/api/create-checkout` ahora incluye locationId** (vía fallback)
⏳ **Próximo paso**: Probar flujo completo (checkout Recurrente + pago)

### Nota sobre locationId
El problema más grande en GHL Custom Providers es obtener el `locationId` de forma automática. Soluciones implementadas:
1. OAuth callback guarda locationId en localStorage
2. iframe busca en localStorage cuando el usuario inicia la sesión
3. **Fallback: locationId conocido hardcodeado** (solución temporal para testing)

Si GHL Custom Providers se supone que deben funcionar de forma completamente automática, podría haber un paso de configuración que falta. **Opción: Crear una app nueva desde cero siguiendo la documentación oficial de GHL.**

---
*Actualización: 11 de Marzo de 2026, 16:40 GMT-6. Implementado formulario fallback + localStorage para locationId.*
