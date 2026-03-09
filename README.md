# GHL Recurrente Bridge

Integración de pagos personalizada para GoHighLevel (GHL) usando Recurrente como gateway de pagos, desplegada en Cloudflare Workers.

## Arquitectura

```
GHL Checkout → paymentsUrl (iframe) → Cloudflare Worker → API Recurrente → respuesta a GHL
```

## Stack

- **Cloudflare Workers** – API serverless
- **Cloudflare D1** – Base de datos SQLite
- **Recurrente** – Gateway de pagos (Guatemala)
- **GoHighLevel** – Custom Payment Provider

## Estructura del Proyecto

```
ghl-recurrente-bridge/
├── src/
│   ├── index.ts          # Entry point – registra todas las rutas
│   ├── router.ts         # Router simple con soporte CORS
│   ├── types.ts          # Tipos TypeScript (Env, GHL, Recurrente)
│   ├── db.ts             # Capa de acceso a D1 (tenants + transactions)
│   ├── recurrente.ts     # Cliente API de Recurrente
│   ├── ghl.ts            # Handlers de GHL (paymentsUrl, queryUrl)
│   └── admin.ts          # Handlers de administración de tenants
├── test/
│   └── index.spec.ts     # Tests con Vitest + Cloudflare Workers pool
├── schema.sql            # Schema de la base de datos D1
├── wrangler.jsonc         # Configuración del Worker
├── tsconfig.json         # Configuración TypeScript
└── package.json
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/` | Info del servicio |
| `GET` | `/health` | Health check con estado de DB |
| `GET` | `/payment` | **paymentsUrl** – página que GHL carga en iframe |
| `GET` | `/payment/success` | Callback exitoso de Recurrente |
| `GET` | `/payment/cancel` | Callback de cancelación |
| `POST` | `/api/create-checkout` | Crea checkout en Recurrente |
| `POST` | `/api/query` | **queryUrl** – acciones server-to-server de GHL |
| `GET` | `/admin/tenants` | Lista todos los tenants |
| `GET` | `/admin/tenant?locationId=X` | Ver tenant específico |
| `POST` | `/admin/tenant` | Crear/actualizar tenant |
| `DELETE` | `/admin/tenant` | Eliminar tenant |

## Desarrollo Local

```bash
# Instalar dependencias
npm install

# Inicializar la base de datos local
npx wrangler d1 execute ghl-recurrente-db --local --file=./schema.sql

# Levantar servidor de desarrollo
npm run dev
# → http://localhost:8787

# Ejecutar tests
npm test

# Registrar un tenant de prueba
curl -X POST http://localhost:8787/admin/tenant \
  -H 'Content-Type: application/json' \
  -d '{
    "locationId": "tu-location-id-de-ghl",
    "publicKey": "tu-public-key-de-recurrente",
    "secretKey": "tu-secret-key-de-recurrente",
    "businessName": "Tu Negocio"
  }'
```

## Deploy a Cloudflare

```bash
# 1. Crear la base de datos D1 en Cloudflare
npx wrangler d1 create ghl-recurrente-db
# → Copia el database_id y actualiza wrangler.jsonc

# 2. Ejecutar schema en D1 remoto
npx wrangler d1 execute ghl-recurrente-db --remote --file=./schema.sql

# 3. Deploy del Worker
npm run deploy
```

## Configuración GHL

Cuando registres tu Custom Payment Provider en GHL:

- **paymentsUrl**: `https://tu-worker.workers.dev/payment`
- **queryUrl**: `https://tu-worker.workers.dev/api/query`

## Multi-tenant

Cada subcuenta de GHL (`locationId`) puede conectarse a una cuenta diferente de Recurrente. Solo necesitas registrar cada tenant con sus credenciales:

```bash
curl -X POST https://tu-worker.workers.dev/admin/tenant \
  -H 'Content-Type: application/json' \
  -d '{
    "locationId": "location-abc-123",
    "publicKey": "pk_live_...",
    "secretKey": "sk_live_...",
    "businessName": "Negocio A"
  }'
```

## Roadmap (próximos pasos)

- [ ] Autenticación para endpoints admin (API key o JWT)
- [ ] Refunds via Recurrente API
- [ ] Suscripciones/pagos recurrentes
- [ ] Webhooks de Recurrente (confirmación asíncrona)
- [ ] Dashboard admin (UI)
- [ ] Rate limiting
- [ ] Logs estructurados
