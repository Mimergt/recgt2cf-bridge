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
	handleConfirmPayment,
	handleForcePayment,
	processGhlPendingPayments,
} from './ghl';
import { handleGhlWebhook } from './webhook';
import {
	handleListTenants,
	handleGetTenant,
	handleUpsertTenant,
	handleDeleteTenant,
	handleToggleTenant,
	handleAdminDashboard,
} from './admin';
import { upsertGhlToken, getGhlToken, getValidGhlToken, getExpiringTokens, refreshGhlToken, getTenant, getSetting } from './db';

const router = new Router();

/** Verify ADMIN_SECRET header for admin-only endpoints */
function requireAdmin(request: Request, env: Env): Response | null {
	const key = request.headers.get('X-Admin-Key') || new URL(request.url).searchParams.get('adminKey') || '';
	if (!env.ADMIN_SECRET || key !== env.ADMIN_SECRET) {
		return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
	}
	return null; // authorized
}

const DEFAULT_SUBSCRIPTION_PRODUCT_URL = 'https://pagos.epic.gt/checkout/';
const DEFAULT_SUBSCRIPTION_PRODUCT_ID = '304';

function buildSubscriptionBuyUrl(env: Env, locationId: string): string {
	const base = env.SUBSCRIPTION_PRODUCT_URL || DEFAULT_SUBSCRIPTION_PRODUCT_URL;
	const url = new URL(base);
	const productId = env.SUBSCRIPTION_PRODUCT_ID || DEFAULT_SUBSCRIPTION_PRODUCT_ID;
	url.searchParams.set('add-to-cart', productId);
	url.searchParams.set('product_id', productId);
	url.searchParams.set('account_id', locationId);
	return url.toString();
}

async function ensureTenantActive(env: Env, locationId: string): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO tenants (location_id, recurrente_public_key, recurrente_secret_key, business_name, is_active)
		VALUES (?, '', '', '', 1)
		ON CONFLICT(location_id) DO UPDATE SET
			is_active = 1,
			updated_at = datetime('now')
	`).bind(locationId).run();
}

async function tryApplyManualActivationCode(env: Env, locationId: string, code: string): Promise<boolean> {
	if (!code) return false;
	try {
		const row = await env.DB.prepare('SELECT id, is_used, location_id FROM manual_activations WHERE code = ? LIMIT 1')
			.bind(code)
			.first<{ id: number; is_used: number; location_id: string | null }>();
		if (!row) return false;
		if (row.is_used === 1 && row.location_id && row.location_id !== locationId) return false;

		await env.DB.prepare(`
			UPDATE manual_activations
			SET is_used = 1, location_id = ?, used_at = datetime('now')
			WHERE id = ?
		`).bind(locationId, row.id).run();

		await ensureTenantActive(env, locationId);
		return true;
	} catch {
		// Table may not exist in all environments; ignore gracefully.
		return false;
	}
}

async function checkSubscriptionStatus(env: Env, locationId: string, subscriptionCode?: string) {
	const buyUrl = buildSubscriptionBuyUrl(env, locationId);

	const tenantRow = await env.DB.prepare('SELECT is_active FROM tenants WHERE location_id = ? LIMIT 1')
		.bind(locationId)
		.first<{ is_active: number }>();
	const tenantActive = tenantRow?.is_active === 1;

	if (subscriptionCode) {
		const activated = await tryApplyManualActivationCode(env, locationId, subscriptionCode);
		if (activated) {
			return { active: true, source: 'manual_code', buyUrl };
		}
	}

	const wpSite = (env.WP_SITE_URL || 'https://pagos.epic.gt').replace(/\/+$/, '');
	const wpKey = env.WP_NEXUS_API_KEY || '';
	if (!wpKey) {
		if (tenantActive) return { active: true, source: 'tenant_active', buyUrl };
		return { active: false, source: 'inactive', buyUrl, message: 'Falta WP_NEXUS_API_KEY en el entorno del Worker.' };
	}

	try {
		const wpUrl = new URL('/wp-json/nexus-sc/v1/check-subscription', wpSite);
		wpUrl.searchParams.set('location_id', locationId);
		wpUrl.searchParams.set('key', wpKey);
		if (subscriptionCode) {
			wpUrl.searchParams.set('subscription_id', subscriptionCode);
			wpUrl.searchParams.set('code', subscriptionCode);
		}

		const resp = await fetch(wpUrl.toString(), { method: 'GET' });
		if (!resp.ok) {
			if (tenantActive) return { active: true, source: 'tenant_active', buyUrl };
			return { active: false, source: 'inactive', buyUrl, message: `No se pudo validar con WooCommerce (${resp.status}).` };
		}

		const data = await resp.json() as any;
		const active = !!(data?.active || data?.is_active || data?.has_active_subscription);
		if (active) {
			await ensureTenantActive(env, locationId);
			return { active: true, source: 'woocommerce', buyUrl };
		}

		return { active: false, source: 'inactive', buyUrl, message: 'No encontramos una suscripción activa para esta sub-cuenta.' };
	} catch {
		if (tenantActive) return { active: true, source: 'tenant_active', buyUrl };
		return { active: false, source: 'inactive', buyUrl, message: 'Error de conexión validando suscripción.' };
	}
}

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
router.post('/api/confirm-payment', handleConfirmPayment);
router.post('/api/force-payment', handleForcePayment);
router.post('/api/resolve-location', async (req, env) => {
	const body = await req.json() as any;
	return handleQueryUrl(new Request(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify({ ...body, type: 'resolve_location' })
	}), env, new URL(req.url).searchParams);
});

router.post('/api/debug-invoice', async (req, env) => {
	const body = await req.json() as any;
	return handleQueryUrl(new Request(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify({ ...body, type: 'debug_invoice' })
	}), env, new URL(req.url).searchParams);
});
router.post('/api/query', handleQueryUrl);

router.get('/api/check-subscription', async (request, env) => {
	const params = new URL(request.url).searchParams;
	const locationId = (params.get('locationId') || params.get('location_id') || '').trim();
	if (!locationId) {
		return jsonResponse({ success: false, error: 'Missing locationId' }, 400);
	}

	const status = await checkSubscriptionStatus(env, locationId);
	return jsonResponse({ success: true, ...status });
});

router.post('/api/activate-subscription', async (request, env) => {
	const body = await request.json() as any;
	const locationId = (body.locationId || '').trim();
	const subscriptionCode = (body.subscriptionCode || body.subscriptionId || '').trim();
	if (!locationId) {
		return jsonResponse({ success: false, error: 'Missing locationId' }, 400);
	}

	const status = await checkSubscriptionStatus(env, locationId, subscriptionCode);
	return jsonResponse({ success: true, ...status });
});

// ─── Static Assets ──────────────────────────────────────────
const ICON_SVG_B64 = 'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iQ2FwYV8yIiBkYXRhLW5hbWU9IkNhcGEgMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgdmlld0JveD0iMCAwIDE5MC4wNyAxOTIuNjEiPgogIDxkZWZzPgogICAgPHN0eWxlPgogICAgICAuY2xzLTEgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTUpOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTYpOwogICAgICB9CgogICAgICAuY2xzLTMgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTQpOwogICAgICB9CgogICAgICAuY2xzLTQgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTMpOwogICAgICB9CgogICAgICAuY2xzLTUgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTIpOwogICAgICB9CgogICAgICAuY2xzLTYgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50KTsKICAgICAgfQoKICAgICAgLmNscy03IHsKICAgICAgICBmaWxsOiAjMmEyMDJiOwogICAgICB9CgogICAgICAuY2xzLTgsIC5jbHMtOSB7CiAgICAgICAgZmlsbDogIzJhMjAyYjsKICAgICAgfQoKICAgICAgLmNscy0xMCB7CiAgICAgICAgZmlsbDogI2VlMmY2NTsKICAgICAgfQoKICAgICAgLmNscy05IHsKICAgICAgICBmb250LWZhbWlseTogT1RDVW5kZXJncm91bmQtUmVndWxhciwgJ09UQyBVbmRlcmdyb3VuZCc7CiAgICAgICAgZm9udC1zaXplOiA3MS43N3B4OwogICAgICAgIGxldHRlci1zcGFjaW5nOiAtLjA1ZW07CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImxpbmVhci1ncmFkaWVudCIgeDE9IjEyNi4xMyIgeTE9IjM1LjgzIiB4Mj0iMTU1LjYyIiB5Mj0iMzUuODMiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZWMzMDY1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjkxIiBzdG9wLWNvbG9yPSIjZWU1MDRlIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXItZ3JhZGllbnQtMiIgeDE9IjExOC45OSIgeTE9IjQzLjk1IiB4Mj0iMTI0LjAyIiB5Mj0iNDMuOTUiIHhsaW5rOmhyZWY9IiNsaW5lYXItZ3JhZGllbnQiLz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibGluZWFyLWdyYWRpZW50LTMiIHgxPSIxMjAuOTEiIHkxPSI1NC44NyIgeDI9IjE1MC41NiIgeTI9IjU0Ljg3IiB4bGluazpocmVmPSIjbGluZWFyLWdyYWRpZW50Ii8+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImxpbmVhci1ncmFkaWVudC00IiB4MT0iMTUyLjc3IiB5MT0iNDYuODIiIHgyPSIxNTcuNzQiIHkyPSI0Ni44MiIgeGxpbms6aHJlZj0iI2xpbmVhci1ncmFkaWVudCIvPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXItZ3JhZGllbnQtNSIgeDE9IjExOS44OCIgeTE9IjMzLjk0IiB4Mj0iMTMxLjMiIHkyPSIzMy45NCIgeGxpbms6aHJlZj0iI2xpbmVhci1ncmFkaWVudCIvPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXItZ3JhZGllbnQtNiIgeDE9IjE0NS4zOSIgeTE9IjU2LjY0IiB4Mj0iMTU2LjkyIiB5Mj0iNTYuNjQiIHhsaW5rOmhyZWY9IiNsaW5lYXItZ3JhZGllbnQiLz4KICA8L2RlZnM+CiAgPGcgaWQ9IkNyb3BfTWFya3MiIGRhdGEtbmFtZT0iQ3JvcCBNYXJrcyI+CiAgICA8Zz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy04IiBkPSJNMTcuNTYsNWgxNTYuNDJjNi4xMiwwLDExLjEsNC45NywxMS4xLDExLjF2MTU4Ljk2YzAsOS42OS03Ljg3LDE3LjU2LTE3LjU2LDE3LjU2SDE3LjU2Yy05LjY5LDAtMTcuNTYtNy44Ny0xNy41Ni0xNy41NlYyMi41NkMwLDEyLjg3LDcuODcsNSwxNy41Niw1WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMTAiIGQ9Ik0yMi41NiwwaDE1Ni40MmM2LjEyLDAsMTEuMSw0Ljk3LDExLjEsMTEuMXYxNTguOTZjMCw5LjY5LTcuODcsMTcuNTYtMTcuNTYsMTcuNTZIMjIuNTZjLTkuNjksMC0xNy41Ni03Ljg3LTE3LjU2LTE3LjU2VjE3LjU2QzUsNy44NywxMi44NywwLDIyLjU2LDBaIi8+CiAgICAgICAgPGc+CiAgICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtNyIgY3g9IjEzOC4zNyIgY3k9IjQ1LjMyIiByPSIyMS4xOCIvPgogICAgICAgICAgPGc+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNiIgZD0iTTEzMC41MSw0My44M2M3LjI3LTIuODUsMTAuNzYtNS41OCwxMC43Ni01LjU4LDAsMCw2Ljk4LTUuMjgsMTQuMzYtMS43OS0yLjM4LTQuNjMtNi41OC04LjE4LTExLjY1LTkuNzEtLjIyLDMuODctMS42OCw3LjUtNC42MSwxMC41LTMuMzksMy40OC04LjEzLDUuNDItMTMuMjMsNS44Mi4wOC43MS4yLDEuMzMuMzIsMS44NSwxLjM0LS4yMiwyLjcyLS41Niw0LjA1LTEuMDlaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNSIgZD0iTTEyNC4wMiw0NS4xOGMtLjAyLS42Mi0uMDYtMS4zMi0uMTEtMi4wNC0xLjU3LS4wMS0zLjE2LS4xNy00Ljc1LS40Ny0uMTEuNzgtLjE3LDEuNTgtLjE4LDIuMzksMS4yNi4xNCwzLjA0LjI1LDUuMDMuMTJaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNCIgZD0iTTE0MC41Niw0OS4yNmwtNi45NCw0LjMycy01LjM5LDMuNjctMTIuNzEuMTdjMi4zNSw0Ljg2LDYuNjgsOC41OSwxMS45MywxMC4xNS43Mi01LjcyLDMuNTUtMTAuNjUsOC43NS0xMy43LDIuNzEtMS41OSw1Ljc4LTIuNDcsOC45Ny0yLjctLjA3LS42My0uMTctMS4xNy0uMjctMS42NS0yLjg1LjM4LTYuMTYsMS4zNi05LjcyLDMuNDFaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTE1Ny43NCw0Ni4xYy0xLjI2LS4yNy0yLjk1LS41LTQuOTctLjQ1LjA0LjU2LjA5LDEuMTcuMTYsMS44LDEuNTQuMDQsMy4wOS4yMyw0LjY0LjU2LjA5LS42My4xNC0xLjI2LjE3LTEuOTFaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTEyMS44NCwzNi4yNHMzLjQxLS43MSw0LjA1LDMuN2MxLjM1LS4zLDIuNTMtLjkyLDMuNDYtMS44NywyLjMzLTIuNCwyLjUxLTYuMzQuODUtMTAuMzQtNC45LDIuMjgtOC42OCw2LjU0LTEwLjMyLDExLjc2LDEuMjcuNDEsMi41Mi42MywzLjcxLjY3LS4zMi0yLjAzLS44Ni0zLjczLTEuNzUtMy45MVoiLz4KICAgICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTU1LjIzLDU0LjM2cy0zLjY1LjY2LTQuNC0zLjZjLTEuMTkuMzItMi4yNy44My0zLjExLDEuNDQtMi45OSwyLjIxLTIuNzYsNS45NC0xLjIyLDEwLjcsNC45Ny0yLjMsOC44LTYuNjQsMTAuNDEtMTEuOTUtMS4xMi0uNDUtMi4zNS0uNjItMy41Ny0uNTguMzksMi4wNi45OCwzLjc5LDEuODgsMy45OFoiLz4KICAgICAgICAgIDwvZz4KICAgICAgICA8L2c+CiAgICAgIDwvZz4KICAgICAgPHBhdGggY2xhc3M9ImNscy04IiBkPSJNMTAyLjE1LDI0Ljg1djYzLjhjMCw1LjgzLTYuMDksOS45OC0xNC42Nyw5Ljk4aC00MC43djY2LjgxaC0yNy42OVYxNC44N2g2OC4zOGM4LjU4LDAsMTQuNjcsNC4xNCwxNC42Nyw5Ljk4Wk03NC40NywzNS4zOWMwLTEuODgtMi40OS0zLjU4LTUuMjYtMy41OGgtMjIuNDJ2NDkuODhoMjIuNDJjMi43NywwLDUuMjYtMS42OSw1LjI2LTMuNTh2LTQyLjcyWiIvPgogICAgICA8dGV4dCBjbGFzcz0iY2xzLTkiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUwLjYyIDE2NS4yNCkgc2NhbGUoMi4xNyAxKSI+PHRzcGFuIHg9IjAiIHk9IjAiPkFZPC90c3Bhbj48L3RleHQ+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=';
router.get('/icon.png', async () => {
	const svgBytes = Uint8Array.from(atob(ICON_SVG_B64), c => c.charCodeAt(0));
	return new Response(svgBytes, {
		headers: {
			'Content-Type': 'image/svg+xml',
			'Cache-Control': 'public, max-age=86400',
			'Access-Control-Allow-Origin': '*'
		}
	});
});

// ─── Admin / Tenant Management (protected) ──────────────────
router.get('/admin/dashboard', async (request, env, params) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	return handleAdminDashboard(request, env, params);
});
router.post('/admin/tenant/toggle', async (request, env, params) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	return handleToggleTenant(request, env, params);
});
router.get('/admin/tenants', async (request, env, params) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	return handleListTenants(request, env, params);
});
router.get('/admin/logs', async (request, env) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	const { results } = await env.DB.prepare('SELECT * FROM tenants ORDER BY createdAt DESC LIMIT 10').all();
	return jsonResponse(results);
});
// Temporary: list recent transactions for debugging
router.get('/admin/transactions', async (request, env) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	try {
		const { results } = await env.DB.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20').all();
		return jsonResponse({ success: true, transactions: results });
	} catch (err) {
		return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
});
// Temporary: list stored GHL tokens for debugging
router.get('/admin/ghl-tokens', async (request, env) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	try {
		const { results } = await env.DB.prepare('SELECT id, location_id, access_token, refresh_token, scopes, expires_at, created_at, updated_at FROM ghl_tokens ORDER BY created_at DESC').all();
		return jsonResponse({ success: true, tokens: results });
	} catch (err) {
		return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

router.get('/admin/list-all-invoices', async (req, env) => {
	const denied = requireAdmin(req, env);
	if (denied) return denied;
	const resp = await handleQueryUrl(new Request(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify({ type: 'list_all_invoices' })
	}), env, new URL(req.url).searchParams);
	return resp || jsonResponse({ success: false, error: 'Not found' }, 404);
});

// Admin: feature toggle for webhook pre-creation (enable per-location)
router.post('/admin/feature', async (request, env) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	try {
		const body = await request.json() as any;
		const { locationId, feature, enabled } = body;
		if (!locationId || !feature || typeof enabled === 'undefined') {
			return jsonResponse({ success: false, error: 'Missing locationId, feature or enabled' }, 400);
		}

		const { setSetting } = await import('./db');
		await setSetting(env.DB, `${feature}:${locationId}`, enabled ? '1' : '0');
		return jsonResponse({ success: true, message: `Feature ${feature} for ${locationId} set to ${enabled}` });
	} catch (err) {
		return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

router.get('/admin/feature', async (request, env) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	try {
		const params = new URL(request.url).searchParams;
		const locationId = params.get('locationId');
		const feature = params.get('feature');
		if (!locationId || !feature) return jsonResponse({ success: false, error: 'Missing locationId or feature' }, 400);
		const { getSetting } = await import('./db');
		const val = await getSetting(env.DB, `${feature}:${locationId}`);
		return jsonResponse({ success: true, feature, locationId, value: val });
	} catch (err) {
		return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

// Webhook endpoint for GHL events
router.post('/webhook/ghl', handleGhlWebhook);

// Admin: re-register payment provider (update paymentsUrl etc.)
router.post('/admin/reconfigure-provider', async (request, env) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	const body = await request.json() as any;
	const locId = body.locationId;
	if (!locId) return jsonResponse({ success: false, error: 'Missing locationId' }, 400);
	const tokenRow = await getValidGhlToken(env.DB, locId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
	if (!tokenRow) return jsonResponse({ success: false, error: 'No GHL token for this location' }, 404);
	try {
		await configurePaymentProvider(env, tokenRow.access_token, locId);
		return jsonResponse({ success: true, message: 'Provider reconfigured for ' + locId });
	} catch (e) {
		return jsonResponse({ success: false, error: (e as Error).message }, 500);
	}
});

// Admin tenant endpoints (protected)
router.get('/admin/tenant', async (request, env, params) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	return handleGetTenant(request, env, params);
});
router.post('/admin/tenant', async (request, env, params) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	return handleUpsertTenant(request, env, params);
});
router.delete('/admin/tenant', async (request, env, params) => {
	const denied = requireAdmin(request, env);
	if (denied) return denied;
	return handleDeleteTenant(request, env, params);
});

// ─── Secure config API (verifies GHL token = app installed) ─
router.get('/api/config', async (request, env) => {
	const params = new URL(request.url).searchParams;
	const locationId = params.get('locationId');
	if (!locationId) return jsonResponse({ success: false, error: 'Missing locationId' }, 400);

	// Verify app is installed on this location
	const token = await getGhlToken(env.DB, locationId);
	if (!token) return jsonResponse({ success: false, error: 'App not installed on this location' }, 403);

	const tenant = await getTenant(env.DB, locationId);
	if (!tenant) return jsonResponse({ success: false, error: 'Tenant not configured' }, 404);

	// Auto-fetch business name from GHL if missing
	if (!tenant.business_name) {
		try {
			const tokenData = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
			if (tokenData) {
				const locRes = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}`, {
					headers: { Authorization: `Bearer ${tokenData.access_token}`, Version: '2021-07-28', Accept: 'application/json' },
				});
				if (locRes.ok) {
					const locData = await locRes.json() as any;
					const locName = locData.location?.name || locData.name || '';
					if (locName) {
						tenant.business_name = locName;
						const { upsertTenant: upsert } = await import('./db');
						await upsert(env.DB, locationId, { businessName: locName });
					}
				}
			}
		} catch {}
	}

	// Mask keys for frontend display
	const mask = (k: string) => k && k.length > 12 ? k.slice(0, 8) + '\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4) : k;
	return jsonResponse({ success: true, tenant: {
		...tenant,
		recurrente_public_key: mask(tenant.recurrente_public_key),
		recurrente_secret_key: mask(tenant.recurrente_secret_key),
		recurrente_public_key_live: mask(tenant.recurrente_public_key_live),
		recurrente_secret_key_live: mask(tenant.recurrente_secret_key_live),
		has_test_keys: !!(tenant.recurrente_public_key && tenant.recurrente_secret_key),
		has_live_keys: !!(tenant.recurrente_public_key_live && tenant.recurrente_secret_key_live),
	}});
});

router.post('/api/config', async (request, env) => {
	const body = await request.json() as any;
	const locationId = body.locationId;
	if (!locationId) return jsonResponse({ success: false, error: 'Missing locationId' }, 400);

	// Verify app is installed on this location
	const token = await getGhlToken(env.DB, locationId);
	if (!token) return jsonResponse({ success: false, error: 'App not installed on this location' }, 403);

	// Server-side validation of Recurrente keys
	const keySets: Array<{pk: string; sk: string; label: string}> = [];
	if (body.publicKey && body.secretKey) keySets.push({ pk: body.publicKey, sk: body.secretKey, label: 'test' });
	if (body.publicKeyLive && body.secretKeyLive) keySets.push({ pk: body.publicKeyLive, sk: body.secretKeyLive, label: 'live' });

	for (const ks of keySets) {
		try {
			const res = await fetch('https://app.recurrente.com/api/checkouts', {
				method: 'GET',
				headers: { 'X-PUBLIC-KEY': ks.pk, 'X-SECRET-KEY': ks.sk },
			});
			if (res.status === 401 || res.status === 403) {
				return jsonResponse({ success: false, error: `Las llaves de ${ks.label} son inv\u00e1lidas. Verifica que las copiaste correctamente desde Recurrente.` }, 400);
			}
		} catch (e) {
			return jsonResponse({ success: false, error: `No se pudo validar las llaves de ${ks.label}. Intenta de nuevo.` }, 500);
		}
	}

	return handleUpsertTenant(new Request(request.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}), env, new URL(request.url).searchParams);
});

// ─── OAuth Callback (GHL App Installation) ─────────────────
router.get('/oauth/callback', async (request, env, params) => {
	const code = params.get('code');
	let accessToken: string | undefined;
	let refreshToken: string | undefined;
	let locationId: string | undefined;
	let companyId: string | undefined;
	let userType: string | undefined;

	let successMessage = 'La aplicación ha sido autorizada en GoHighLevel.';
	let errorMessage = '';
	const allLocationIds: string[] = [];

	if (code) {
		try {
			// 1. Exchange OAuth code for an Access Token
			const tokenBody = new URLSearchParams({
				client_id: env.GHL_CLIENT_ID,
				client_secret: env.GHL_CLIENT_SECRET,
				grant_type: 'authorization_code',
				code: code,
				user_type: 'Location',
				redirect_uri: 'https://recurrente-bridge.epicgt.workers.dev/oauth/callback'
			});

			const tokenResponse = await fetch('https://services.leadconnectorhq.com/oauth/token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json',
				},
				body: tokenBody.toString()
			});

			if (!tokenResponse.ok) {
				const errText = await tokenResponse.text();
				throw new Error('Token exchange failed (' + tokenResponse.status + '): ' + errText);
			}

			const tokenData = await tokenResponse.json() as any;
			console.log('[OAuth] Token response fields:', JSON.stringify({
				userType: tokenData.userType,
				companyId: tokenData.companyId,
				locationId: tokenData.locationId,
				userId: tokenData.userId,
				scope: tokenData.scope?.substring(0, 80),
				hasAccessToken: !!tokenData.access_token,
				hasRefreshToken: !!tokenData.refresh_token,
			}));

			accessToken = tokenData.access_token;
			refreshToken = tokenData.refresh_token;
			locationId = tokenData.locationId;
			companyId = tokenData.companyId;
			userType = tokenData.userType;
			const expiresIn = tokenData.expires_in; // seconds
			const expiresAt = expiresIn
				? new Date(Date.now() + expiresIn * 1000).toISOString()
				: null;

			// --- Case A: Location-level token (has locationId) ---
			if (accessToken && locationId) {
				allLocationIds.push(locationId);
				await upsertGhlToken(env.DB, locationId, accessToken, refreshToken || null, tokenData.scope || null, expiresAt);
				await configurePaymentProvider(env, accessToken, locationId);
				successMessage = 'Sub-cuenta ' + locationId + ' conectada exitosamente.';
			}
			// --- Case B: Company/Agency-level token (no locationId) ---
			else if (accessToken && companyId && !locationId) {
				// List all locations under this company and create location tokens
				try {
					const locationsRes = await fetch('https://services.leadconnectorhq.com/locations/search', {
						method: 'POST',
						headers: {
							'Authorization': 'Bearer ' + accessToken,
							'Version': '2021-07-28',
							'Content-Type': 'application/json',
							'Accept': 'application/json'
						},
						body: JSON.stringify({ companyId: companyId, limit: 100 })
					});
					if (locationsRes.ok) {
						const locData = await locationsRes.json() as any;
						const locations = locData.locations || [];
						console.log('[OAuth] Found', locations.length, 'locations for company', companyId);

						// Generate location-level tokens for each sub-account
						for (const loc of locations) {
							const locId = loc.id || loc._id;
							if (!locId) continue;
							allLocationIds.push(locId);
							try {
								const locTokenRes = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', {
									method: 'POST',
									headers: {
										'Authorization': 'Bearer ' + accessToken,
										'Version': '2021-07-28',
										'Content-Type': 'application/json',
										'Accept': 'application/json'
									},
									body: JSON.stringify({ companyId, locationId: locId })
								});
								if (locTokenRes.ok) {
									const locToken = await locTokenRes.json() as any;
									const locExpiresAt = locToken.expires_in
										? new Date(Date.now() + locToken.expires_in * 1000).toISOString()
										: null;
									await upsertGhlToken(env.DB, locId, locToken.access_token, locToken.refresh_token || null, locToken.scope || null, locExpiresAt);
									await configurePaymentProvider(env, locToken.access_token, locId);
									console.log('[OAuth] Configured location', locId);
								} else {
									console.error('[OAuth] Failed to get token for location', locId, await locTokenRes.text());
								}
							} catch (e) {
								console.error('[OAuth] Error processing location', locId, e);
							}
						}
						successMessage = 'Agencia conectada. Se configuraron ' + allLocationIds.length + ' sub-cuentas.';
						// If only one location, use it directly
						if (allLocationIds.length === 1) locationId = allLocationIds[0];
					} else {
						console.error('[OAuth] Failed to list locations:', await locationsRes.text());
						successMessage = 'App autorizada a nivel de Agencia. Selecciona tu sub-cuenta en la página de configuración.';
					}
				} catch (e) {
					console.error('[OAuth] Error listing locations:', e);
					successMessage = 'App autorizada a nivel de Agencia. Selecciona tu sub-cuenta en la página de configuración.';
				}
			}
		} catch (error) {
			console.error('[OAuth] Error:', error);
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	} else {
		errorMessage = 'No se recibió ningún código de autorización de GHL.';
	}

	// 3. Error page
	if (errorMessage) {
		const safeError = errorMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const errorHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Error de Instalación</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff5f5; color: #c92a2a; text-align: center; margin: 0; padding: 20px; }
    .box { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #ffc9c9; max-width: 600px; }
    h2 { margin-top: 0; }
    .code { background: #f8f9fa; padding: 10px; border-radius: 4px; border: 1px solid #e9ecef; color: #333; text-align: left; font-family: monospace; font-size: 0.85em; margin-top: 10px; overflow-wrap: break-word; white-space: pre-wrap; }
    a { color: #0b6efd; display: inline-block; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Hubo un problema</h2>
    <p>No se pudo completar la instalación.</p>
    <div class="code">${safeError}</div>
    <a href="/">Volver a intentar</a>
  </div>
</body>
</html>`;
		return new Response(errorHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	}

	// 4. Success: redirect to GHL sub-account dashboard
	let redirectUrl = 'https://recurrente-bridge.epicgt.workers.dev/';

	if (locationId) {
		try {
			const { getSetting } = await import('./db');
			const ghlDomain = await getSetting(env.DB, 'ghl_app_domain');
			if (ghlDomain) {
				redirectUrl = `https://${ghlDomain}/v2/location/${encodeURIComponent(locationId)}/dashboard`;
			}
		} catch {}
	}

	const safeSuccess = successMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const successHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Conexión Exitosa</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8f9fa; color: #333; text-align: center; margin: 0; }
    .box { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 600px; }
    h2 { color: #2f9e44; margin-top: 0; }
    .spinner { width: 48px; height: 48px; border: 4px solid #e9ecef; border-top-color: #2f9e44; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <h2>¡Conexión Exitosa!</h2>
    <p>${safeSuccess}</p>
    <p>Redirigiendo al panel...</p>
  </div>
  <script>
    setTimeout(function() {
      window.location.href = '${redirectUrl}';
    }, 1500);
  </script>
</body>
</html>`;
	return new Response(successHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

/** Connect API keys for a location.
 *  Provider name, description, logo, paymentsUrl, and queryUrl are managed
 *  entirely by the marketplace Payment Provider config — GHL propagates them. */
async function configurePaymentProvider(env: Env, token: string, locId: string): Promise<void> {
	const headers = {
		'Authorization': 'Bearer ' + token,
		'Version': '2021-07-28',
		'Content-Type': 'application/json'
	};
	try {
		const connectRes = await fetch('https://services.leadconnectorhq.com/payments/custom-provider/connect?locationId=' + locId, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				live: { apiKey: 'bridge_live', publishableKey: 'bridge_pub_live' },
				test: { apiKey: 'bridge_test', publishableKey: 'bridge_pub_test' }
			})
		});
		if (!connectRes.ok) {
			console.error('[configurePaymentProvider] Connect failed for', locId, connectRes.status, await connectRes.text());
		} else {
			console.log('[configurePaymentProvider] Connected for', locId);
		}
	} catch (e) {
		console.error('[configurePaymentProvider] Error for', locId, e);
	}
}

// ─── Root (Cargado en los iframes de GHL) ──────────────────
router.get('/', async (request, env) => {
	const oAuthRedirect = encodeURIComponent('https://recurrente-bridge.epicgt.workers.dev/oauth/callback');
	const scopes = [
		'payments/custom-provider.readonly', 'payments/custom-provider.write',
		'payments/orders.readonly', 'payments/orders.write',
		'payments/integration.readonly', 'payments/integration.write',
		'payments/transactions.readonly',
		'invoices.write', 'invoices/schedule.readonly',
		'locations.readonly',
		'oauth.readonly', 'oauth.write'
	].join('+');
	const oauthUrl = 'https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=' + oAuthRedirect + '&client_id=' + env.GHL_CLIENT_ID + '&scope=' + scopes + '&version_id=69aa4f5d412b25fc2d651a94';

	// --- Server-side locationId detection ---
	const url = new URL(request.url);
	let detectedLocationId = url.searchParams.get('locationId') || url.searchParams.get('location_id') || '';

	// Try extracting from Referer header (works for iframe loads where Referer is sent)
	if (!detectedLocationId) {
		const referer = request.headers.get('referer') || request.headers.get('Referer') || '';
		const refMatch = referer.match(/\/location\/([a-zA-Z0-9]+)/);
		if (refMatch) detectedLocationId = refMatch[1];
	}

	// Do NOT auto-select from DB — let the client-side picker handle it

	// Escape for safe injection into HTML
	const safeLocationId = detectedLocationId.replace(/[^a-zA-Z0-9]/g, '');

	const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EpicPay - Configuración Recurrente</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #0f172a; color: #e2e8f0; }
    .container { max-width: 640px; margin: 0 auto; }
    .card { background: #1e293b; padding: 28px; border-radius: 12px; }
    h1 { color: #38bdf8; margin-bottom: 12px; font-size: 1.5rem; }
    label { display: block; margin-top: 14px; font-weight: 600; font-size: 0.85rem; color: #94a3b8; }
    input { width: 100%; padding: 10px 12px; margin-top: 4px; border: 1px solid #334155; border-radius: 8px; font-size: 14px; background: #0f172a; color: #e2e8f0; }
    input:focus { outline: none; border-color: #38bdf8; }
    input[readonly] { color: #64748b; }
    button { margin-top: 20px; width: 100%; padding: 12px 16px; border: none; border-radius: 10px; background: #2563eb; color: white; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .alert { padding: 12px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
    .alert.success { background: #166534; color: #4ade80; }
    .alert.error { background: #7f1d1d; color: #fca5a5; }
    .oauth-btn { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; }
    .oauth-btn:hover { opacity: 0.85; }
    .divider { border-top: 1px solid #334155; margin: 20px 0; }
    .section-test { background: #1a1c2e; border: 1px solid #854d0e; border-radius: 10px; padding: 16px; margin-top: 16px; }
    .section-live { background: #0f2a1e; border: 1px solid #166534; border-radius: 10px; padding: 16px; margin-top: 16px; }
    .section-test h3 { color: #fbbf24; margin-bottom: 4px; font-size: 0.95rem; }
    .section-live h3 { color: #4ade80; margin-bottom: 4px; font-size: 0.95rem; }
    .toggle-row { display: flex; align-items: center; gap: 12px; margin-top: 20px; }
    .toggle-row label { margin: 0; font-size: 15px; color: #e2e8f0; }
    .switch { position: relative; width: 50px; height: 26px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #475569; border-radius: 26px; transition: 0.3s; }
    .slider:before { content: ''; position: absolute; height: 20px; width: 20px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.3s; }
    .switch input:checked + .slider { background: #10b981; }
    .switch input:checked + .slider:before { transform: translateX(24px); }
    .mode-badge { display: inline-block; padding: 3px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .mode-badge.test { background: #422006; color: #fbbf24; }
    .mode-badge.live { background: #052e16; color: #4ade80; }
    .note { margin-top: 12px; font-size: 13px; color: #94a3b8; }
    details { margin-top: 8px; margin-bottom: 16px; }
    summary { cursor: pointer; color: #38bdf8; font-size: 0.9rem; font-weight: 600; padding: 8px 0; }
    summary:hover { text-decoration: underline; }
    .help-content { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px 16px; margin-top: 8px; font-size: 0.85rem; line-height: 1.6; color: #cbd5e1; }
    .help-content strong { color: #e2e8f0; }
    .sub-header { margin-bottom: 16px; }
    .sub-name { display: block; font-size: 1.1rem; color: #e2e8f0; }
    .loc-id { display: block; font-family: monospace; font-size: 0.75rem; color: #64748b; margin-top: 2px; }
    .masked-val { display: block; font-family: monospace; font-size: 0.85rem; color: #94a3b8; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn-edit { display: block; margin: 10px auto 0; background: #334155; color: #38bdf8; border: 1px solid #475569; border-radius: 6px; padding: 6px 20px; font-size: 0.8rem; cursor: pointer; }
    .btn-edit:hover { background: #475569; }
		.sub-gate { background: #131f39; border: 1px solid #334155; border-radius: 10px; padding: 16px; margin-top: 10px; }
		.sub-gate h3 { color: #38bdf8; margin-bottom: 8px; font-size: 1rem; }
		.sub-gate p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 10px; }
		.gate-actions { display: grid; gap: 10px; margin-top: 10px; }
		.btn-secondary { margin-top: 0; background: #334155; color: #e2e8f0; }
		.btn-buy { margin-top: 0; display: inline-block; text-decoration: none; text-align: center; width: 100%; padding: 12px 16px; border-radius: 10px; background: #f59e0b; color: #111827; font-size: 15px; font-weight: 700; }
		.btn-buy:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <div style="text-align:center;margin-bottom:24px;">
      <img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iQ2FwYV8yIiBkYXRhLW5hbWU9IkNhcGEgMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgdmlld0JveD0iMCAwIDE5MC4wNyAxOTIuNjEiPgogIDxkZWZzPgogICAgPHN0eWxlPgogICAgICAuY2xzLTEgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTUpOwogICAgICB9CgogICAgICAuY2xzLTIgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTYpOwogICAgICB9CgogICAgICAuY2xzLTMgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTQpOwogICAgICB9CgogICAgICAuY2xzLTQgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTMpOwogICAgICB9CgogICAgICAuY2xzLTUgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50LTIpOwogICAgICB9CgogICAgICAuY2xzLTYgewogICAgICAgIGZpbGw6IHVybCgjbGluZWFyLWdyYWRpZW50KTsKICAgICAgfQoKICAgICAgLmNscy03IHsKICAgICAgICBmaWxsOiAjMmEyMDJiOwogICAgICB9CgogICAgICAuY2xzLTgsIC5jbHMtOSB7CiAgICAgICAgZmlsbDogIzJhMjAyYjsKICAgICAgfQoKICAgICAgLmNscy0xMCB7CiAgICAgICAgZmlsbDogI2VlMmY2NTsKICAgICAgfQoKICAgICAgLmNscy05IHsKICAgICAgICBmb250LWZhbWlseTogT1RDVW5kZXJncm91bmQtUmVndWxhciwgJ09UQyBVbmRlcmdyb3VuZCc7CiAgICAgICAgZm9udC1zaXplOiA3MS43N3B4OwogICAgICAgIGxldHRlci1zcGFjaW5nOiAtLjA1ZW07CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImxpbmVhci1ncmFkaWVudCIgeDE9IjEyNi4xMyIgeTE9IjM1LjgzIiB4Mj0iMTU1LjYyIiB5Mj0iMzUuODMiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZWMzMDY1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjkxIiBzdG9wLWNvbG9yPSIjZWU1MDRlIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXItZ3JhZGllbnQtMiIgeDE9IjExOC45OSIgeTE9IjQzLjk1IiB4Mj0iMTI0LjAyIiB5Mj0iNDMuOTUiIHhsaW5rOmhyZWY9IiNsaW5lYXItZ3JhZGllbnQiLz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibGluZWFyLWdyYWRpZW50LTMiIHgxPSIxMjAuOTEiIHkxPSI1NC44NyIgeDI9IjE1MC41NiIgeTI9IjU0Ljg3IiB4bGluazpocmVmPSIjbGluZWFyLWdyYWRpZW50Ii8+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImxpbmVhci1ncmFkaWVudC00IiB4MT0iMTUyLjc3IiB5MT0iNDYuODIiIHgyPSIxNTcuNzQiIHkyPSI0Ni44MiIgeGxpbms6aHJlZj0iI2xpbmVhci1ncmFkaWVudCIvPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXItZ3JhZGllbnQtNSIgeDE9IjExOS44OCIgeTE9IjMzLjk0IiB4Mj0iMTMxLjMiIHkyPSIzMy45NCIgeGxpbms6aHJlZj0iI2xpbmVhci1ncmFkaWVudCIvPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXItZ3JhZGllbnQtNiIgeDE9IjE0NS4zOSIgeTE9IjU2LjY0IiB4Mj0iMTU2LjkyIiB5Mj0iNTYuNjQiIHhsaW5rOmhyZWY9IiNsaW5lYXItZ3JhZGllbnQiLz4KICA8L2RlZnM+CiAgPGcgaWQ9IkNyb3BfTWFya3MiIGRhdGEtbmFtZT0iQ3JvcCBNYXJrcyI+CiAgICA8Zz4KICAgICAgPGc+CiAgICAgICAgPHBhdGggY2xhc3M9ImNscy04IiBkPSJNMTcuNTYsNWgxNTYuNDJjNi4xMiwwLDExLjEsNC45NywxMS4xLDExLjF2MTU4Ljk2YzAsOS42OS03Ljg3LDE3LjU2LTE3LjU2LDE3LjU2SDE3LjU2Yy05LjY5LDAtMTcuNTYtNy44Ny0xNy41Ni0xNy41NlYyMi41NkMwLDEyLjg3LDcuODcsNSwxNy41Niw1WiIvPgogICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMTAiIGQ9Ik0yMi41NiwwaDE1Ni40MmM2LjEyLDAsMTEuMSw0Ljk3LDExLjEsMTEuMXYxNTguOTZjMCw5LjY5LTcuODcsMTcuNTYtMTcuNTYsMTcuNTZIMjIuNTZjLTkuNjksMC0xNy41Ni03Ljg3LTE3LjU2LTE3LjU2VjE3LjU2QzUsNy44NywxMi44NywwLDIyLjU2LDBaIi8+CiAgICAgICAgPGc+CiAgICAgICAgICA8Y2lyY2xlIGNsYXNzPSJjbHMtNyIgY3g9IjEzOC4zNyIgY3k9IjQ1LjMyIiByPSIyMS4xOCIvPgogICAgICAgICAgPGc+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNiIgZD0iTTEzMC41MSw0My44M2M3LjI3LTIuODUsMTAuNzYtNS41OCwxMC43Ni01LjU4LDAsMCw2Ljk4LTUuMjgsMTQuMzYtMS43OS0yLjM4LTQuNjMtNi41OC04LjE4LTExLjY1LTkuNzEtLjIyLDMuODctMS42OCw3LjUtNC42MSwxMC41LTMuMzksMy40OC04LjEzLDUuNDItMTMuMjMsNS44Mi4wOC43MS4yLDEuMzMuMzIsMS44NSwxLjM0LS4yMiwyLjcyLS41Niw0LjA1LTEuMDlaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNSIgZD0iTTEyNC4wMiw0NS4xOGMtLjAyLS42Mi0uMDYtMS4zMi0uMTEtMi4wNC0xLjU3LS4wMS0zLjE2LS4xNy00Ljc1LS40Ny0uMTEuNzgtLjE3LDEuNTgtLjE4LDIuMzksMS4yNi4xNCwzLjA0LjI1LDUuMDMuMTJaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtNCIgZD0iTTE0MC41Niw0OS4yNmwtNi45NCw0LjMycy01LjM5LDMuNjctMTIuNzEuMTdjMi4zNSw0Ljg2LDYuNjgsOC41OSwxMS45MywxMC4xNS43Mi01LjcyLDMuNTUtMTAuNjUsOC43NS0xMy43LDIuNzEtMS41OSw1Ljc4LTIuNDcsOC45Ny0yLjctLjA3LS42My0uMTctMS4xNy0uMjctMS42NS0yLjg1LjM4LTYuMTYsMS4zNi05LjcyLDMuNDFaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMyIgZD0iTTE1Ny43NCw0Ni4xYy0xLjI2LS4yNy0yLjk1LS41LTQuOTctLjQ1LjA0LjU2LjA5LDEuMTcuMTYsMS44LDEuNTQuMDQsMy4wOS4yMyw0LjY0LjU2LjA5LS42My4xNC0xLjI2LjE3LTEuOTFaIi8+CiAgICAgICAgICAgIDxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTEyMS44NCwzNi4yNHMzLjQxLS43MSw0LjA1LDMuN2MxLjM1LS4zLDIuNTMtLjkyLDMuNDYtMS44NywyLjMzLTIuNCwyLjUxLTYuMzQuODUtMTAuMzQtNC45LDIuMjgtOC42OCw2LjU0LTEwLjMyLDExLjc2LDEuMjcuNDEsMi41Mi42MywzLjcxLjY3LS4zMi0yLjAzLS44Ni0zLjczLTEuNzUtMy45MVoiLz4KICAgICAgICAgICAgPHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTU1LjIzLDU0LjM2cy0zLjY1LjY2LTQuNC0zLjZjLTEuMTkuMzItMi4yNy44My0zLjExLDEuNDQtMi45OSwyLjIxLTIuNzYsNS45NC0xLjIyLDEwLjcsNC45Ny0yLjMsOC44LTYuNjQsMTAuNDEtMTEuOTUtMS4xMi0uNDUtMi4zNS0uNjItMy41Ny0uNTguMzksMi4wNi45OCwzLjc5LDEuODgsMy45OFoiLz4KICAgICAgICAgIDwvZz4KICAgICAgICA8L2c+CiAgICAgIDwvZz4KICAgICAgPHBhdGggY2xhc3M9ImNscy04IiBkPSJNMTAyLjE1LDI0Ljg1djYzLjhjMCw1LjgzLTYuMDksOS45OC0xNC42Nyw5Ljk4aC00MC43djY2LjgxaC0yNy42OVYxNC44N2g2OC4zOGM4LjU4LDAsMTQuNjcsNC4xNCwxNC42Nyw5Ljk4Wk03NC40NywzNS4zOWMwLTEuODgtMi40OS0zLjU4LTUuMjYtMy41OGgtMjIuNDJ2NDkuODhoMjIuNDJjMi43NywwLDUuMjYtMS42OSw1LjI2LTMuNTh2LTQyLjcyWiIvPgogICAgICA8dGV4dCBjbGFzcz0iY2xzLTkiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUwLjYyIDE2NS4yNCkgc2NhbGUoMi4xNyAxKSI+PHRzcGFuIHg9IjAiIHk9IjAiPkFZPC90c3Bhbj48L3RleHQ+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=" alt="EpicPay" style="height:72px;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.3));">
    </div>
    <div class="card">
      <h1>Configuración Recurrente</h1>
      <details>
        <summary>¿Dónde encuentro las llaves?</summary>
        <div class="help-content">
          Desde tu dashboard de <strong>Recurrente</strong>, ve a <strong>Configuración &gt; API</strong>. Ahí encontrarás:<br><br>
          <strong>API Key (pública):</strong> Se usa en el frontend para crear checkouts.<br>
          <strong>Secret Key (privada):</strong> Se usa en el backend para operaciones sensibles. Nunca la expongas en el frontend.<br><br>
          También tendrás acceso a un ambiente de pruebas (sandbox) con credenciales separadas para que puedas probar sin procesar pagos reales.
        </div>
      </details>
      <div id="content"></div>
      <div id="oauthSection" style="display:none">
        <div class="divider"></div>
        <p class="note">¿Primera vez? Conecta tu cuenta de GoHighLevel para configurar automáticamente.</p>
        <a id="oauthLink" class="oauth-btn" href="${oauthUrl}">Conectar con GoHighLevel</a>
      </div>
    </div>
  </div>
  <script>
    var content = document.getElementById('content');
    var oauthSection = document.getElementById('oauthSection');
    var locationId = '${safeLocationId}' || null;
		var buySubscriptionUrl = '';

    function setStatus(message, type) {
      var existing = document.getElementById('status');
      if (existing) existing.remove();
      var div = document.createElement('div');
      div.id = 'status';
      div.className = 'alert ' + (type === 'error' ? 'error' : 'success');
      div.textContent = message;
      content.prepend(div);
    }

		function renderSubscriptionGate(info) {
			var message = (info && info.message) || 'Esta sub-cuenta no tiene suscripción activa aún.';
			buySubscriptionUrl = (info && info.buyUrl) || '';

			var html = '';
			html += '<div class="sub-header">' +
				'<strong class="sub-name">' + (locationId || 'Sub-cuenta') + '</strong>' +
				'<span class="loc-id">' + (locationId || '') + '</span>' +
				'</div>';
			html += '<div class="sub-gate">';
			html += '<h3>Activa tu suscripción</h3>';
			html += '<p>' + message + '</p>';
			html += '<label>ID de Suscripción / Código</label>';
			html += '<input id="subscriptionCode" placeholder="Ej. sub_123 o código de activación" />';
			html += '<div class="gate-actions">';
			html += '<button id="btnValidateCode">Guardar y validar</button>';
			html += '<button id="btnRefreshSubscription" class="btn-secondary">Ya compré, validar suscripción</button>';
			if (buySubscriptionUrl) {
				html += '<a class="btn-buy" href="' + buySubscriptionUrl + '">COMPRAR SUSCRIPCIÓN</a>';
			}
			html += '</div>';
			html += '<p class="note">Producto WooCommerce ID: 304</p>';
			html += '</div>';

			content.innerHTML = html;
			oauthSection.style.display = 'none';

			document.getElementById('btnValidateCode').addEventListener('click', function() {
				var btn = this;
				btn.disabled = true;
				btn.textContent = 'Validando...';
				var subscriptionCode = (document.getElementById('subscriptionCode').value || '').trim();
				fetch('/api/activate-subscription', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ locationId: locationId, subscriptionCode: subscriptionCode })
				})
				.then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
				.then(function(res) {
					btn.disabled = false;
					btn.textContent = 'Guardar y validar';
					if (!res.ok || !res.data.success) throw new Error(res.data.error || 'No se pudo validar la suscripción.');
					if (res.data.active) {
						setStatus('Suscripción activa. Ahora puedes configurar las llaves.', 'success');
						setTimeout(function() { loadTenantConfig(); }, 400);
						return;
					}
					renderSubscriptionGate(res.data);
					setStatus(res.data.message || 'No encontramos una suscripción activa.', 'error');
				})
				.catch(function(e) {
					btn.disabled = false;
					btn.textContent = 'Guardar y validar';
					setStatus(e.message || 'Error validando suscripción.', 'error');
				});
			});

			document.getElementById('btnRefreshSubscription').addEventListener('click', function() {
				checkSubscriptionThenContinue(true);
			});
		}

    function renderForm(tenant) {
      var pkTest = (tenant && tenant.recurrente_public_key) || '';
      var skTest = (tenant && tenant.recurrente_secret_key) || '';
      var pkLive = (tenant && tenant.recurrente_public_key_live) || '';
      var skLive = (tenant && tenant.recurrente_secret_key_live) || '';
      var mode = (tenant && tenant.mode) || 'test';
      var hasTestKeys = tenant && tenant.has_test_keys;
      var hasLiveKeys = tenant && tenant.has_live_keys;
      var bizName = (tenant && tenant.business_name) || '';

      // Sub-account header
      var html = '<div class="sub-header">' +
        '<strong class="sub-name">' + (bizName || locationId) + '</strong>' +
        '<span class="loc-id">' + (locationId || '') + '</span>' +
        '</div>';

      // --- Test keys section ---
      html += '<div class="section-test">' +
        '<h3>Llaves de Prueba (Test)</h3>';

      if (hasTestKeys) {
        html += '<div class="key-display" id="displayTest">' +
          '<label>Clave Pública (Test)</label>' +
          '<div class="masked-val">' + pkTest + '</div>' +
          '<label>Clave Secreta (Test)</label>' +
          '<div class="masked-val">' + skTest + '</div>' +
          '<button type="button" class="btn-edit" onclick="window.editKeys(&#39;test&#39;)">Editar llaves</button>' +
          '</div>';
        html += '<div class="key-edit" id="editTest" style="display:none">' +
          '<label>Public Key (Test)</label>' +
          '<input id="pkTest" placeholder="pk_test_xxx" />' +
          '<label>Secret Key (Test)</label>' +
          '<input id="skTest" placeholder="sk_test_xxx" />' +
          '</div>';
      } else {
        html += '<label>Public Key (Test)</label>' +
          '<input id="pkTest" placeholder="pk_test_xxx" />' +
          '<label>Secret Key (Test)</label>' +
          '<input id="skTest" placeholder="sk_test_xxx" />';
      }
      html += '</div>';

      // --- Live toggle ---
      html += '<div class="toggle-row">' +
        '<label class="switch"><input type="checkbox" id="modeToggle"' + (mode === 'live' ? ' checked' : '') + '><span class="slider"></span></label>' +
        '<label>Modo LIVE <span id="modeBadge" class="mode-badge ' + mode + '">' + mode.toUpperCase() + '</span></label>' +
        '</div>';

      // --- Live keys section ---
      html += '<div class="section-live" id="liveSection" style="display:' + (mode === 'live' ? 'block' : 'none') + '">' +
        '<h3>Llaves de Producción (Live)</h3>';

      if (hasLiveKeys) {
        html += '<div class="key-display" id="displayLive">' +
          '<label>Clave Pública (Live)</label>' +
          '<div class="masked-val">' + pkLive + '</div>' +
          '<label>Clave Secreta (Live)</label>' +
          '<div class="masked-val">' + skLive + '</div>' +
          '<button type="button" class="btn-edit" onclick="window.editKeys(&#39;live&#39;)">Editar llaves</button>' +
          '</div>';
        html += '<div class="key-edit" id="editLive" style="display:none">' +
          '<label>Public Key (Live)</label>' +
          '<input id="pkLive" placeholder="pk_live_xxx" />' +
          '<label>Secret Key (Live)</label>' +
          '<input id="skLive" placeholder="sk_live_xxx" />' +
          '</div>';
      } else {
        html += '<label>Public Key (Live)</label>' +
          '<input id="pkLive" placeholder="pk_live_xxx" />' +
          '<label>Secret Key (Live)</label>' +
          '<input id="skLive" placeholder="sk_live_xxx" />';
      }
      html += '</div>';

      html += '<p class="note">Modo actual: <strong id="modeLabel">' + (mode === 'live' ? 'LIVE — se usan las llaves de producción' : 'TEST — se usan las llaves de prueba') + '</strong></p>';
      html += '<button id="save">Guardar configuración</button>';
      html += '<div id="validating" style="display:none;text-align:center;margin-top:12px;color:#94a3b8;font-size:0.85rem;">Validando llaves con Recurrente...</div>';
      content.innerHTML = html;

      // Toggle handler
      document.getElementById('modeToggle').addEventListener('change', function() {
        var isLive = this.checked;
        document.getElementById('liveSection').style.display = isLive ? 'block' : 'none';
        document.getElementById('modeBadge').className = 'mode-badge ' + (isLive ? 'live' : 'test');
        document.getElementById('modeBadge').textContent = isLive ? 'LIVE' : 'TEST';
        document.getElementById('modeLabel').innerHTML = isLive ? 'LIVE — se usan las llaves de producción' : 'TEST — se usan las llaves de prueba';
      });

      // Save handler
      document.getElementById('save').addEventListener('click', function() {
        var btn = this;
        var isLive = document.getElementById('modeToggle').checked;
        var pkTestInput = document.getElementById('pkTest');
        var skTestInput = document.getElementById('skTest');
        var pkLiveInput = document.getElementById('pkLive');
        var skLiveInput = document.getElementById('skLive');

        var pkt = pkTestInput ? pkTestInput.value.trim() : '';
        var skt = skTestInput ? skTestInput.value.trim() : '';
        var pkl = pkLiveInput ? pkLiveInput.value.trim() : '';
        var skl = skLiveInput ? skLiveInput.value.trim() : '';

        // If keys are not being edited (inputs hidden), don't send them
        var editTestVisible = document.getElementById('editTest');
        var editLiveVisible = document.getElementById('editLive');
        var sendTestKeys = !editTestVisible || editTestVisible.style.display !== 'none';
        var sendLiveKeys = !editLiveVisible || editLiveVisible.style.display !== 'none';

        // Validate prefix format
        if (sendTestKeys) {
          if (!pkt || !skt) { setStatus('Debes proporcionar las llaves de prueba (test).', 'error'); return; }
          if (!pkt.startsWith('pk_test_')) { setStatus('La Public Key de test debe empezar con pk_test_', 'error'); return; }
          if (!skt.startsWith('sk_test_')) { setStatus('La Secret Key de test debe empezar con sk_test_', 'error'); return; }
        }
        if (isLive && sendLiveKeys) {
          if (!pkl || !skl) { setStatus('Para activar modo LIVE debes proporcionar las llaves de producción.', 'error'); return; }
          if (!pkl.startsWith('pk_live_')) { setStatus('La Public Key live debe empezar con pk_live_', 'error'); return; }
          if (!skl.startsWith('sk_live_')) { setStatus('La Secret Key live debe empezar con sk_live_', 'error'); return; }
        }

        var payload = { locationId: locationId, mode: isLive ? 'live' : 'test' };
        if (sendTestKeys) { payload.publicKey = pkt; payload.secretKey = skt; }
        if (sendLiveKeys && pkl && skl) { payload.publicKeyLive = pkl; payload.secretKeyLive = skl; }

        btn.disabled = true;
        btn.textContent = 'Validando llaves...';
        document.getElementById('validating').style.display = 'block';

        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          btn.disabled = false;
          btn.textContent = 'Guardar configuración';
          document.getElementById('validating').style.display = 'none';
          if (!res.ok) throw new Error(res.data.error || 'Error');
          setStatus('Configuración guardada correctamente.', 'success');
          setTimeout(function() { loadTenantConfig(); }, 800);
        })
        .catch(function(e) {
          btn.disabled = false;
          btn.textContent = 'Guardar configuración';
          document.getElementById('validating').style.display = 'none';
          setStatus(e.message || 'Error al guardar', 'error');
        });
      });
      oauthSection.style.display = 'none';
    }

    function renderNoLocation() {
      content.innerHTML =
        '<div class="alert error">No se detectó la sub-cuenta. Conecta tu cuenta de GoHighLevel para configurar.</div>';
      oauthSection.style.display = 'block';
    }

		function checkSubscriptionThenContinue(showMessage) {
			content.innerHTML = '<p>Validando suscripción...</p>';
			fetch('/api/check-subscription?locationId=' + encodeURIComponent(locationId))
				.then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
				.then(function(res) {
					if (!res.ok || !res.data.success) throw new Error(res.data.error || 'No se pudo validar la suscripción.');
					if (res.data.active) {
						if (showMessage) setStatus('Suscripción activa detectada.', 'success');
						loadTenantConfig();
						return;
					}
					renderSubscriptionGate(res.data);
					if (showMessage) setStatus(res.data.message || 'No encontramos suscripción activa.', 'error');
				})
				.catch(function(e) {
					renderSubscriptionGate({ message: e.message || 'Error de validación de suscripción.' });
				});
		}

    function loadTenantConfig() {
      content.innerHTML = '<p>Cargando configuración...</p>';
      fetch('/api/config?locationId=' + encodeURIComponent(locationId))
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          if (res.data.error === 'App not installed on this location') {
            content.innerHTML =
              '<div class="alert error">Esta app aún no está instalada en esta sub-cuenta. Conecta primero con GoHighLevel.</div>';
            oauthSection.style.display = 'block';
            return;
          }
          if (!res.ok || !res.data.success) {
            renderForm(null);
            return;
          }
          renderForm(res.data.tenant);
        })
        .catch(function(e) {
          renderForm(null);
          setStatus(e.message || 'Error al consultar', 'error');
        });
    }

    function init() {
      if (locationId) {
				checkSubscriptionThenContinue(false);
      } else {
        renderNoLocation();
      }
    }

    window.editKeys = function(type) {
      var displayEl = document.getElementById(type === 'test' ? 'displayTest' : 'displayLive');
      var editEl = document.getElementById(type === 'test' ? 'editTest' : 'editLive');
      if (displayEl) displayEl.style.display = 'none';
      if (editEl) editEl.style.display = 'block';
    };

    init();
  </script>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
});

// ─── Export Worker ────────────────────────────────────────────
export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env, ctx);
	},
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(processGhlPendingPayments(env));
		ctx.waitUntil(refreshExpiringTokens(env));
	},
} satisfies ExportedHandler<Env>;

/** Proactively refresh tokens expiring in the next 30 minutes */
async function refreshExpiringTokens(env: Env): Promise<void> {
	try {
		const result = await getExpiringTokens(env.DB, 30);
		const rows = result.results || [];
		if (rows.length === 0) return;
		console.log('[Cron] Refreshing', rows.length, 'expiring tokens');
		for (const row of rows) {
			const r = row as any;
			if (!r.refresh_token || !r.location_id) continue;
			await refreshGhlToken(env.DB, r.location_id, r.refresh_token, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
		}
	} catch (e) {
		console.error('[Cron] Token refresh error:', e);
	}
}
