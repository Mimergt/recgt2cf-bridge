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
import { handleGhlWebhook } from './webhook';
import {
	handleListTenants,
	handleGetTenant,
	handleUpsertTenant,
	handleDeleteTenant,
} from './admin';
import { upsertGhlToken } from './db';

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
router.post('/api/resolve-location', async (req, env) => {
	const body = await req.json() as any;
	return handleQueryUrl(new Request(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify({ ...body, type: 'resolve_location' })
	}), env, new URL(req.url).searchParams);
});
router.post('/api/query', handleQueryUrl);

// ─── Admin / Tenant Management ───────────────────────────────
router.get('/admin/tenants', handleListTenants);
router.get('/admin/logs', async (request, env) => {
	const { results } = await env.DB.prepare('SELECT * FROM tenants ORDER BY createdAt DESC LIMIT 10').all();
	return jsonResponse(results);
});
// Temporary: list recent transactions for debugging
router.get('/admin/transactions', async (request, env) => {
	try {
		const { results } = await env.DB.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20').all();
		return jsonResponse({ success: true, transactions: results });
	} catch (err) {
		return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
});
// Temporary: list stored GHL tokens for debugging
router.get('/admin/ghl-tokens', async (request, env) => {
	try {
		const { results } = await env.DB.prepare('SELECT id, location_id, access_token, refresh_token, scopes, expires_at, created_at, updated_at FROM ghl_tokens ORDER BY created_at DESC').all();
		return jsonResponse({ success: true, tokens: results });
	} catch (err) {
		return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

// Admin: feature toggle for webhook pre-creation (enable per-location)
router.post('/admin/feature', async (request, env) => {
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
router.get('/admin/tenant', handleGetTenant);
router.post('/admin/tenant', handleUpsertTenant);
router.delete('/admin/tenant', handleDeleteTenant);

// ─── OAuth Callback (GHL App Installation) ─────────────────
router.get('/oauth/callback', async (request, env, params) => {
	const code = params.get('code');
	let accessToken: string | undefined;
	let locationId: string | undefined;

	let successMessage = 'La aplicación ha sido autorizada en GoHighLevel.';
	let errorMessage = '';

	if (code) {
		try {
			// 1. Exchange OAuth code for an Access Token
			const tokenParams = new URLSearchParams({
				client_id: env.GHL_CLIENT_ID,
				client_secret: env.GHL_CLIENT_SECRET,
				grant_type: 'authorization_code',
				code: code,
				redirect_uri: 'https://recurrente-bridge.epicgt.workers.dev/oauth/callback'
			});

			const tokenResponse = await fetch('https://services.leadconnectorhq.com/oauth/token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: tokenParams.toString()
			});

			if (!tokenResponse.ok) {
				const errText = await tokenResponse.text();
				throw new Error('Fallo al obtener el token: ' + errText);
			}

			const tokenData = await tokenResponse.json() as { access_token: string, locationId?: string };
			accessToken = tokenData.access_token;
			locationId = tokenData.locationId;

			// Persist GHL access token server-side so we can call GHL APIs for this location
			try {
				if (accessToken && locationId) {
					await upsertGhlToken(env.DB, locationId, accessToken, (tokenData as any).refresh_token || null, (tokenData as any).scope || null, (tokenData as any).expires_at || null);
				}
			} catch (dbErr) {
				console.error('Failed to persist GHL token for location', locationId, dbErr);
			}

			// 2. Configure the Custom Payment Provider URLs automatically via API!
			if (accessToken && locationId) {
				const commonHeaders = {
					'Authorization': `Bearer ${accessToken}`,
					'Version': '2021-07-28',
					'Content-Type': 'application/json'
				};

				let debugInfo = '';

				// --- STEP 1: Check if Provider Base Config exists ---
				const checkResponse = await fetch(`https://services.leadconnectorhq.com/payments/custom-provider/connect?locationId=${locationId}`, {
					method: 'GET',
					headers: commonHeaders
				});
				const checkData = await checkResponse.text();
				debugInfo += `- GET /connect (Check): ${checkResponse.status} - ${checkData.substring(0, 100)}\n`;

				const basePayload = {
					name: 'EPICPay1',
					description: 'Integración oficial de Recurrente puenteada en Cloudflare',
					imageUrl: 'https://cdn.recurrente.com/favicon.png',
					paymentsUrl: 'https://recurrente-bridge.epicgt.workers.dev/payment?chargeId={chargeId}&amount={amount}&currency={currency}&contactEmail={contactEmail}&name={name}',
					queryUrl: 'https://recurrente-bridge.epicgt.workers.dev/api/query'
				};

				// --- STEP 2: Create Base Provider if it doesn't exist (Fixes 422) ---
				// Based on research, /provider is for creation, /connect is for keys.
				const createResponse = await fetch(`https://services.leadconnectorhq.com/payments/custom-provider/provider?locationId=${locationId}`, {
					method: 'POST',
					headers: commonHeaders,
					body: JSON.stringify(basePayload)
				});
				const createData = await createResponse.text();
				debugInfo += `- POST /provider (Create): ${createResponse.status} - ${createData.substring(0, 100)}\n`;

				// --- STEP 3: Connect API Keys ---
				const connectResponse = await fetch(`https://services.leadconnectorhq.com/payments/custom-provider/connect?locationId=${locationId}`, {
					method: 'POST',
					headers: commonHeaders,
					body: JSON.stringify({
						live: { apiKey: 'apiKey_placeholder', publishableKey: 'pubKey_placeholder' },
						test: { apiKey: 'test_apiKey_placeholder', publishableKey: 'test_pubKey_placeholder' }
					})
				});
				const connectData = await connectResponse.text();
				debugInfo += `- POST /connect (Keys): ${connectResponse.status} - ${connectData.substring(0, 100)}\n`;

				if (!connectResponse.ok) {
					errorMessage = `GHL rechazó el registro. No se pudo completar la conexión de llaves.\n\n` +
						`DEBUG INFO:\n` +
						`- Client ID: ${env.GHL_CLIENT_ID}\n` +
						`- locationId: ${locationId}\n` +
						debugInfo;
				} else {
					successMessage = '¡Conexión exitosa! Las URLs y llaves se configuraron correctamente.';
				}
			} else if (accessToken && !locationId) {
				successMessage = 'La App se autorizó a nivel de Agencia con éxito.';
			}
		} catch (error) {
			console.error('OAuth Error:', error);
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	} else {
		errorMessage = 'No se recibió ningún código de autorización de GHL.';
	}

	// 3. Final response: If there's an error, show a pretty error page
	if (errorMessage) {
		const errorHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Error de Instalación</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #fff5f5; color: #c92a2a; text-align: center; margin: 0; }
    .box { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #ffc9c9; max-width: 600px; }
    h2 { margin-top: 0; }
    .code { background: #f8f9fa; padding: 10px; border-radius: 4px; border: 1px solid #e9ecef; color: #333; text-align: left; font-family: monospace; font-size: 0.9em; margin-top: 10px; overflow-wrap: break-word; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Hubo un problema</h2>
    <p>${errorMessage.includes('GHL rechazó') ? 'GoHighLevel bloqueó el registro de la pasarela.' : 'No se pudo completar la instalación.'}</p>
    <div class="code">${errorMessage}</div>
    <p><small style="color: #666;">Copia este error y envíalo para soporte.</small></p>
  </div>
</body>
</html>`;
		return new Response(errorHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	}

	// 4. Final Response: Save locationId to localStorage and redirect
	const finalRedirectUrl = (locationId)
		? `https://app.gohighlevel.com/v2/location/${locationId}/settings/payments/integrations`
		: `https://app.gohighlevel.com/v2/agency/marketplace/installed-apps`;

	// If we have a locationId, save it to localStorage before redirecting
	if (locationId) {
		const successHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Completando Instalación...</title>
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
    <h2>¡Instalación Exitosa!</h2>
    <p>Se está completando la configuración y redirigiendo...</p>
  </div>
  <script>
    // Save locationId to localStorage so the payment iframe can access it
    localStorage.setItem('ghl_location_id', '${locationId}');
    console.log('Saved locationId to localStorage:', '${locationId}');
    // Redirect after 1 second
    setTimeout(() => {
      window.location.href = '${finalRedirectUrl}';
    }, 1000);
  </script>
</body>
</html>`;
		return new Response(successHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	}

	return Response.redirect(finalRedirectUrl, 302);
});

// ─── Root (Cargado en los iframes de GHL) ──────────────────
router.get('/', async () => {
	const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>EpicPay Config</title>
  <style>
    body { font-family: sans-serif; padding: 40px; text-align: center; background: #f0f2f5; color: #1c1e21; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: inline-block; }
    h1 { color: #0080ff; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>EpicPay Bridge Ready</h1>
    <p>Esta es la página de configuración de tu pasarela Recurrente.</p>
    <p><small style="color: #65676b;">Versión 0.1.0 • Desarrollado por EPIC.gt</small></p>
  </div>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
});

// ─── Export Worker ────────────────────────────────────────────
export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env);
	},
} satisfies ExportedHandler<Env>;
