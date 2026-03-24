# Project Memory: GHL-Recurrente Bridge (EPICPay1)

Este documento sirve como memoria técnica y contexto para agentes de IA o desarrolladores que retomen este proyecto.

## 1. Objetivo del Proyecto
Crear un puente (Bridge) mediante **Cloudflare Workers** para integrar la pasarela de pagos **Recurrente** como un **Custom Payment Provider** en **GoHighLevel (GHL) API v2**.

## 2. Infraestructura
- **CF Worker:** `https://recurrente-bridge.epicgt.workers.dev/`
- **D1 DB:** `ghl-recurrente-db` (c3cab438-4c2c-4941-a8c3-3cc0b3443284)
- **GHL App:** `Alpha EpicPay`, Client ID `69aa4f5d412b25fc2d651a94-mmed28do`, Provider Name `EPICPay1`
- **GHL whitelabel:** `app.nexus.epic.gt` / API: `api.nexus.epic.gt`
- **Sub-cuentas:** `4jq4IBO2szzCj4eNcsvC` (principal), `F3KaWF6FPROLt1nbADW0`
- **ADMIN_SECRET:** `epicpay-admin-2026` (header `X-Admin-Key`)
- **invoice_domain:** `https://api.nexus.epic.gt` (en bridge_settings D1)

## 3. Flujo de Pago (v7 — invoices + payment links, 17 marzo 2026) ✅ FUNCIONAL

### Flujo A: Invoices (facturas)
```
GHL Invoice → "Pagar" → paymentsUrl iframe (/payment) →
  iframe envía JSON.stringify({ type: "custom_provider_ready", loaded: true }) →
  GHL responde con payment_initiate_props (amount, currency, transactionId, contact, locationId) →
  iframe crea Recurrente checkout via POST /api/create-checkout (currency forzada a GTQ) →
  Popup window.open() → Recurrente checkout →
  Pago exitoso → /payment/success?popup=1 → relay page postMessage RECURRENTE_SUCCESS al opener →
  iframe recibe RECURRENTE_SUCCESS → envía JSON.stringify({ type: "custom_element_success_response", chargeId }) →
  GHL MARCA PAGADO INSTANTÁNEAMENTE ✅ (lock liberado, factura pagada)
```

### Flujo B: Payment Links (órdenes)
```
GHL Payment Link → Cliente llena datos → "Pagar" → paymentsUrl iframe (/payment) →
  iframe envía custom_provider_ready (con reintentos cada 2s, hasta 5 veces) →
  GHL NO responde con payment_initiate_props (bug/comportamiento diferente para orders) →
  Después de 12s timeout → auto-detect fallback:
    1. Busca invoices pendientes (status='sent') via GET /invoices/
    2. Si no hay → busca orders pendientes via GET /payments/orders?altId={locId}
    3. Primera order con status != completed/paid/refunded → usa esa order
  iframe crea Recurrente checkout → Popup → Pago → Relay → custom_element_success_response →
  GHL MARCA PAGADO ✅
```

**Diferencia clave:** Para payment links y tienda, GHL NO envía `payment_initiate_props`. El iframe debe auto-detectar la orden pendiente via API.

**Tiempo:** ~30 segundos (invoices) / ~45 segundos (payment links/tienda, incluye 12s de auto-detect)
**Confirmado (17 marzo 2026):** 
- Invoice: INV-000016, GTQ111.00 (10:14 PM) ✅
- Payment Link: Producto 9, GTQ109.00 (~10:30 PM) ✅
- Tienda (Store): Producto 1, GTQ101.00 (~10:45 PM) ✅
- **Mobile (19 marzo 2026):**
- Invoice: ✅ (botón "Pagar ahora" → nueva pestaña)
- Payment Link: ✅
- **Los 3 tipos de pago funcionan en Desktop + Mobile ✅**

## Próximos pasos (19 marzo 2026)
1. ~~Re-testing completo de los 3 tipos de pago~~ ✅ HECHO (desktop + mobile)
2. ~~Soporte móvil~~ ✅ HECHO (botón "Pagar ahora" + polling + background record-payment)
3. ~~Multi-tenant~~ ✅ HECHO (probado con claves test de otra cuenta Recurrente)
4. ~~Token refresh~~ ✅ HECHO (auto-refresh en cada llamada + cron proactivo cada minuto)
5. Config page por location
6. Limpieza de código (debug logging)
7. Desinstalar/Reinstalar app — validar flujo OAuth completo

## 4. El Bloqueo 422 (resuelto desde v1)
GHL rechaza el "Connect" si no existe la "Base Config". Protocolo de 2 pasos implementado en `src/index.ts`:
1. `POST /payments/custom-provider/provider?locationId={id}` — registra metadatos
2. `POST /payments/custom-provider/connect?locationId={id}` — registra llaves API

## 5. Problemas Resueltos

| Problema | Solución |
|---|---|
| GHL NO transmite datos al iframe (chargeId, amount, etc.) | auto-detect: busca invoices en todas las subcuentas con token OAuth |
| Placeholders literales `{chargeId}` en URL | handleCreateCheckout resuelve contra GHL API |
| mode `live`/`test` en record-payment | Lee `liveMode` del invoice real en GHL |
| Monto incorrecto | Usa `invoice.total` del API, no heurística |
| 409 "Payment recording already in progress" | Protocolo oficial GHL: `custom_provider_ready` → `payment_initiate_props` → `custom_element_success_response` (JSON.stringify obligatorio) |
| setTimeout no confiable en CF Workers | Cron `scheduled()` handler en lugar de setTimeout |
| window.close() no funciona en redirect | Redirect 302 directo a factura pagada |
| postMessage no reconocido por GHL | **JSON.stringify()** obligatorio — GHL espera string, no objeto JS |
| Recurrente 422 currency error | Forzar `currency: 'GTQ'` siempre en createCheckout (Recurrente es solo Guatemala) |
| Payment Links no envían payment_initiate_props | Auto-detect orders: `GET /payments/orders?altId={locId}` busca orders pendientes + reintentar custom_provider_ready cada 2s |

## 6. Archivos Clave

| Archivo | Propósito |
|---|---|
| `src/index.ts` | Router, OAuth callback, admin endpoints, scheduled cron handler |
| `src/ghl.ts` | handlePaymentSuccess (server-side), handleConfirmPayment (D1 poll), handlePaymentsUrl, processGhlPendingPayments (cron) |
| `src/db.ts` | CRUD D1: tenants, transactions, ghl_tokens, settings, getGhlPendingTransactions() |
| `src/recurrente.ts` | createCheckout, getCheckoutStatus, toCents |
| `src/admin.ts` | CRUD tenants via HTTP |
| `src/types.ts` | Env, Tenant (test+live keys+mode), Transaction |
| `wrangler.jsonc` | Config CF, D1 binding, cron `*/1 * * * *` |
| `schema.sql` | Schema D1: tenants, transactions, ghl_tokens, bridge_settings |

## 7. D1 — Estados de Transacciones

- `pending` — checkout creado, aún no pagado
- `completed` — pagado y registrado exitosamente en GHL
- `ghl_pending` — pagado en Recurrente, pendiente de registro en GHL (cron activo)
- `failed` — error irrecuperable

## 8. Settings en bridge_settings

- `invoice_domain` = base URL para redirect al recibo (`https://api.nexus.epic.gt`)
- `invoice_domain_{locationId}` = override por location
- `{feature}:{locationId}` = feature toggles (ej: `webhook_enabled:locationId`)

## 9. OAuth
- URL: `marketplace.gohighlevel.com/oauth/chooselocation?...&version_id=69aa4f5d412b25fc2d651a94`
- Token exchange: `application/x-www-form-urlencoded` (NO JSON)
- Tokens guardados en `ghl_tokens` table (D1)

## 10. Test/Live Keys
- Tenant: 4 campos (pk_test, sk_test, pk_live, sk_live) + mode
- `getActiveKeys(tenant)` retorna el par correcto según mode

## 11. paymentsUrl y Auto-detect
- GHL envía placeholders literales: `{chargeId}`, `{amount}`, `{locationId}`
- `debug_invoice` busca en TODAS las sub-cuentas conectadas vía tokens OAuth
- `handleCreateCheckout` resuelve placeholders buscando en todas las locations

## 12. Diagnóstico Confirmado: 409 "Payment Recording Already in Progress"

### Qué encontramos (logs `wrangler tail`, 16 marzo 2026)
```
[Background] Invoice status: sent | payments: []
[Background] record-payment response: 409 {"message":"Payment recording already in progress"}
```

- `payments[]` siempre vacío → el lock NO es borrable vía API
- Lock dura exactamente **~5 minutos**
- `mode: "live"/"test"` era incorrecto → corregido a `mode: "card"` (tipo de método de pago)

### Causa raíz
GHL crea un lock interno cuando **carga el iframe** (`paymentsUrl`). Ese lock espera que el iframe envíe `window.parent.postMessage()` con la señal de éxito. Nosotros redirigimos `window.top.location.href` → matamos el iframe → GHL nunca recibe la señal → lock expira en ~5 min.

## 13. Popup + postMessage — Historial de intentos (17 marzo 2026)

### El problema
Todos los formatos de postMessage probados (7 formatos × 12 reintentos) fallaban con:
`"No se puede analizar el mensaje del evento: MessageEvent"`

### La causa raíz
`window.parent.postMessage(obj, '*')` envía un **objeto JavaScript**. GHL espera un **string JSON** y hace `JSON.parse()` internamente. Al recibir un objeto, `JSON.parse()` falla.

### La solución (una línea)
```js
// ANTES (falla — GHL no puede parsear un objeto)
window.parent.postMessage({ type: 'custom_provider_ready', loaded: true }, '*');

// DESPUÉS (funciona — GHL parsea el string JSON correctamente)
window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
```

### Bugs adicionales resueltos en la misma sesión
- **Recurrente 422 "Prices currency is not included in the list"**: GHL envía `currency: "USD"` pero Recurrente solo acepta `"GTQ"`. Fix: forzar `currency: 'GTQ'` en `createCheckout()`.
- **GHL no llena URL params**: Los placeholders `{chargeId}`, `{amount}` en `paymentsUrl` quedan literales para invoices. GHL envía los datos reales via `payment_initiate_props` postMessage.

## 14. Protocolo Oficial GHL Custom Payment Provider ✅

**Docs:** https://marketplace.gohighlevel.com/docs/marketplace-modules/Payments/index.html

### Mensajes postMessage (TODOS deben ser JSON.stringify)

| Dirección | Tipo | Propósito |
|---|---|---|
| iframe → GHL | `custom_provider_ready` | Iframe listo, enviar datos de pago |
| GHL → iframe | `payment_initiate_props` | Datos: amount, currency, transactionId, locationId, contact |
| iframe → GHL | `custom_element_success_response` | Pago exitoso, liberar lock. Incluir `chargeId` |
| iframe → GHL | `custom_element_error_response` | Pago fallido. Incluir `error.description` |
| iframe → GHL | `custom_element_close_response` | Usuario canceló |
| GHL → server | queryUrl POST `{ type: "verify" }` | Verificación server-to-server. Responder `{ success: true }` |

## 15. Próximos Pasos (priorizados — actualizado 19 marzo 2026)
1. ~~**Re-test los 3 tipos de pago**~~ ✅ HECHO (desktop + mobile confirmado)
2. ~~**Soporte móvil**~~ ✅ HECHO (botón "Pagar ahora" + polling + background record-payment)
3. ~~**Payment Links (Orders)**~~ ✅ HECHO
4. ~~**Tienda (Store)**~~ ✅ HECHO
5. ~~**Multi-tenant**~~ ✅ HECHO (probado con claves test de otra cuenta)
6. ~~**Token refresh**~~ ✅ HECHO (getValidGhlToken + refreshGhlToken + cron proactivo)
7. **Desinstalar/Reinstalar** — validar flujo OAuth desde cero
8. **Config page**: `invoice_domain` por location
9. **Limpieza de código**: remover verbose debug logging del iframe
10. **Subscripciones/Recurring**: soporte de pagos recurrentes (si se necesita)
