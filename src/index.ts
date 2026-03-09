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
			service: 'ghl-recurrente-bridge',
			timestamp: new Date().toISOString(),
			database: 'connected',
		});
	} catch (error) {
		return jsonResponse({
			status: 'degraded',
			service: 'ghl-recurrente-bridge',
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
