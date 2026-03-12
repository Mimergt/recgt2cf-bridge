# Addendum: Cambios recientes y estado (11 de Marzo de 2026)

Este addendum complementa `INTEGRATION_MEMORY.md` con un resumen técnico actualizado y pasos siguientes.

## Resumen breve

- Objetivo: eliminar el formulario manual en el iframe y garantizar que el checkout de Recurrente se cree automáticamente (server-side o desde el iframe) usando los datos que GHL entrega o descubriendo cargos con tokens guardados.

## Endpoints añadidos

- `GET /payments/payment` (iframe público para el `paymentsUrl`)
- `POST /api/create-checkout` (crea checkout en Recurrente y persiste transacción)
- `POST /api/query` (acciones: `get_pending_charge`, `get_pending_charge_global`, `ensure_checkout`, `ensure_checkout_global`)
- `GET /oauth/callback` (OAuth callback que persiste `access_token` y `locationId`)
- `POST /webhook/ghl` (pre-creación de checkouts al recibir eventos)
- Endpoints admin: `/admin/ghl-tokens`, `/admin/feature`, `/admin/tenant`

## BD (D1)

- `ghl_tokens` (locationId, access_token, scopes, created_at)
- `bridge_settings` (feature toggles por locationId)
- `transactions` (checkout_id, checkout_url, amount, currency, ghl_charge_id, status)

## Archivos clave modificados

- `src/index.ts` — OAuth, routing, persistencia de tokens
- `src/ghl.ts` — iframe, `/api/create-checkout`, `/api/query`, parsing defensivo
- `src/db.ts` — helpers D1
- `src/recurrente.ts` — cliente Recurrente
- `src/webhook.ts` — webhook receiver
- `src/admin.ts` — endpoints admin temporales
- `schema.sql` — tablas nuevas

## Flujo implementado (resumen)

1. OAuth callback persiste `access_token` y `locationId`.
2. Worker guarda token en `ghl_tokens`.
3. Webhook crea checkout en Recurrente y guarda `checkout_url` en `transactions` (si habilitado).
4. Iframe intenta recibir datos; si ve placeholders consulta `/api/query` para encontrar `checkout_url`.
5. Actualmente hay un fallback manual (para pruebas) que debe eliminarse.

## Pruebas realizadas

- Simulación de webhook -> checkout creado con `checkout_url` válido.
- `/api/create-checkout` con `amount` numérico -> éxito.
- Polling a `/api/query` mostró `checkout_url` persistente.

## Problemas detectados

- GHL frecuentemente pasa placeholders literales (`{amount}`, `{chargeId}`) al iframe; reenviarlos a Recurrente provoca 422.
- GHL no siempre postMessage con datos del invoice; por eso la solución server-side (webhook / discovery) es necesaria.

## Próximos pasos recomendados

1. Adaptar el `iframe` para parsear el objeto invoice Proxy-like que pegaste en `varios.txt` y usar esos campos para crear el checkout automáticamente.
2. Mejorar `ensure_checkout` para coincidir con el shape exacto de las APIs GHL usadas por tu cuenta.
3. Añadir webhook listener de Recurrente para actualizar transacciones tras pago.
4. Añadir UI admin para ver tokens/transacciones/toggles.

---

Archivo generado automáticamente como addendum a `INTEGRATION_MEMORY.md`.
