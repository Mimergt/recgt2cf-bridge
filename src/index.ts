/**
 * GHL Recurrente Bridge
 *
 * Cloudflare Worker that bridges GoHighLevel Custom Payment Provider
 * with Recurrente payment gateway (Guatemala).
 *
 * Architecture:
 *   GHL Checkout → paymentsUrl (iframe) → Worker → Recurrente API → GHL
 *
 * Endpoints:
 *   GET  /health              → Health check
 *   GET  /payment             → paymentsUrl (GHL iframe page)
 *   GET  /payment/success     → Post-payment success redirect
 *   GET  /payment/cancel      → Post-payment cancel redirect
 *   POST /api/create-checkout → Create Recurrente checkout session
 *   POST /api/query           → queryUrl (GHL server-to-server actions)
 *   GET  /admin/tenants       → List all tenants
 *   GET  /admin/tenant        → Get single tenant
 *   POST /admin/tenant        → Create/update tenant
 *   DELETE /admin/tenant      → Delete tenant
 */

import type { Env } from './types';
import { Router, jsonResponse } from './router';
import {
	handlePaymentsUrl,
	handlePaymentSuccess,
	handlePaymentCancel,
	handleCreateCheckout,
	handleQueryUrl,
} from './ghl';
import {
	handleListTenants,
	handleGetTenant,
	handleUpsertTenant,
	handleDeleteTenant,
} from './admin';

const router = new Router();

// ─── Health Check ───────────────────────────────────────────
router.get('/health', async (request, env) => {
	// Quick DB connectivity test
	try {
		await env.DB.prepare('SELECT 1').first();
		return jsonResponse({
			status: 'ok',
			service: 'recurrente-bridge',
			timestamp: new Date().toISOString(),
			database: 'connected',
		});
	} catch (error) {
		return jsonResponse({
			status: 'degraded',
			service: 'recurrente-bridge',
			timestamp: new Date().toISOString(),
			database: 'error',
			error: error instanceof Error ? error.message : 'Unknown DB error',
		}, 503);
	}
});

// ─── GHL Payment Integration ───────────────────────────────
router.get('/payment', handlePaymentsUrl);
router.get('/payment/success', handlePaymentSuccess);
router.get('/payment/cancel', handlePaymentCancel);
router.post('/api/create-checkout', handleCreateCheckout);
router.post('/api/query', handleQueryUrl);

// ─── Admin / Tenant Management ───────────────────────────────
router.get('/admin/tenants', handleListTenants);
router.get('/admin/tenant', handleGetTenant);
router.post('/admin/tenant', handleUpsertTenant);
router.delete('/admin/tenant', handleDeleteTenant);

// ─── OAuth Callback (GHL App Installation) ─────────────────
router.get('/oauth/callback', async (request, env, params) => {
	// GHL sends a `code` parameter here. For a full marketplace app,
	// you would exchange this code for an access token.
	// For our private MVP, we just show a success message to finish the install flow.
	const code = params.get('code');

	const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Instalada</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8f9fa; color: #333; text-align: center; }
    .box { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    h2 { color: #2f9e44; }
  </style>
</head>
<body>
  <div class="box">
    <h2>¡Conexión Exitosa!</h2>
    <p>La aplicación ha sido autorizada en GoHighLevel.</p>
    ${code ? '<p style="font-size: 0.8rem; color: #888;">(Código recibido)</p>' : ''}
    <p>Ya puedes cerrar esta ventana y regresar a GHL.</p>
  </div>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
});

// ─── Root ────────────────────────────────────────────────────
router.get('/', async () => {
	return jsonResponse({
		service: 'GHL Recurrente Bridge',
		version: '0.1.0',
		docs: {
			health: 'GET /health',
			paymentsUrl: 'GET /payment',
			queryUrl: 'POST /api/query',
			createCheckout: 'POST /api/create-checkout',
			adminTenants: 'GET /admin/tenants',
		},
	});
});

// ─── Export Worker ────────────────────────────────────────────
export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env);
	},
} satisfies ExportedHandler<Env>;
