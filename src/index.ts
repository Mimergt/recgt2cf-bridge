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
import {
	handleAppPage,
	handleActivateCode,
	handleCheckSubscription,
	handleTenantStatus,
	handleGenerateCode,
	handleListCodes,
	handleAdminDashboard,
} from './subscription';

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
// ─── Nexus Subscription Gate ────────────────────────────────
router.get('/app', handleAppPage);
router.post('/app/activate-code', handleActivateCode);
router.get('/api/check-subscription', handleCheckSubscription);
router.post('/api/tenant-status', handleTenantStatus);
router.post('/admin/generate-code', handleGenerateCode);
router.get('/admin/codes', handleListCodes);
router.get('/admin/dashboard', handleAdminDashboard);

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

router.post('/api/debug-invoice', async (req, env) => {
	const body = await req.json() as any;
	return handleQueryUrl(new Request(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify({ ...body, type: 'debug_invoice' })
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
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Nexus Configuración</title>
	<style>
		:root {
			--bg: #071738;
			--card: #1b2d4f;
			--card-2: #172643;
			--text: #e9f1ff;
			--muted: #96abd0;
			--line: #2d446d;
			--brand: #34c3ff;
			--brand-dark: #2aa9df;
			--ok: #2abf72;
			--warn: #f0a31b;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			background: radial-gradient(1300px 700px at 50% -20%, #163770 0%, var(--bg) 48%);
			color: var(--text);
		}
		.wrap { max-width: 760px; margin: 12px auto; padding: 0 14px; }
		.logo-box {
			width: 88px;
			height: 88px;
			margin: 8px auto 12px;
			border-radius: 12px;
			background: linear-gradient(160deg, #f72585 0%, #ff2f68 100%);
			display: flex;
			align-items: center;
			justify-content: center;
			box-shadow: 0 8px 24px rgba(255, 44, 109, .35);
			font-weight: 900;
			font-size: 30px;
			letter-spacing: .02em;
		}
		.card {
			background: linear-gradient(180deg, var(--card) 0%, var(--card-2) 100%);
			border: 1px solid var(--line);
			border-radius: 14px;
			box-shadow: 0 16px 40px rgba(0, 6, 20, .45);
			overflow: hidden;
		}
		.head { padding: 18px 20px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; align-items: center; }
		.title { margin: 0; font-size: 42px; line-height: 1.08; color: var(--brand); letter-spacing: -0.02em; }
		.sub { margin: 3px 0 0; font-size: 13px; color: var(--muted); }
		.body { padding: 18px 20px; }
		.status { padding: 11px 12px; border-radius: 10px; font-size: 14px; margin-bottom: 14px; border: 1px solid; }
		.status.ok { background: rgba(42, 191, 114, .16); color: #9cf0c2; border-color: rgba(108, 229, 162, .45); }
		.status.warn { background: rgba(240, 163, 27, .16); color: #ffd38a; border-color: rgba(240, 163, 27, .5); }
		.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
		.field { margin-bottom: 12px; }
		label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px; color: #b7caea; text-transform: uppercase; letter-spacing: .06em; }
		input {
			width: 100%;
			border: 1px solid #3c5582;
			border-radius: 9px;
			background: #081a3a;
			padding: 11px 12px;
			font-size: 14px;
			color: var(--text);
		}
		input:focus { outline: 0; border-color: var(--brand); box-shadow: 0 0 0 2px rgba(52,195,255,.18); }
		.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
		button, a.btn {
			border: 0;
			border-radius: 10px;
			padding: 10px 14px;
			font-size: 14px;
			font-weight: 700;
			text-decoration: none;
			cursor: pointer;
		}
		.btn-primary { background: #3368de; color: #fff; }
		.btn-primary:hover { background: var(--brand-dark); }
		.btn-soft { background: #314a73; color: #9ad5ff; }
		.btn-soft:hover { background: #365585; }
		.muted { font-size: 12px; color: var(--muted); margin-top: 7px; }
		.divider { margin: 18px 0; height: 1px; border: 0; background: var(--line); }
		.message { min-height: 18px; margin-top: 10px; font-size: 13px; }
		.msg-ok { color: #8ff0bb; }
		.msg-err { color: #ff9a9a; }
		.hidden { display: none; }
		.pill { padding: 5px 8px; font-size: 12px; border-radius: 20px; font-weight: 700; }
		.pill.ok { background: rgba(42, 191, 114, .2); color: #9cf0c2; }
		.pill.warn { background: rgba(240, 163, 27, .2); color: #ffd38a; }
		.help summary {
			color: var(--brand);
			cursor: pointer;
			font-weight: 700;
			margin-top: 8px;
		}
		.test-box {
			border: 1px solid rgba(240, 163, 27, .58);
			border-radius: 12px;
			padding: 14px;
			background: rgba(15, 25, 49, .55);
		}
		.mode-row {
			display: flex;
			align-items: center;
			gap: 10px;
			margin-top: 12px;
		}
		.switch {
			width: 50px;
			height: 28px;
			border-radius: 14px;
			background: #60728e;
			position: relative;
		}
		.switch::after {
			content: '';
			position: absolute;
			left: 3px;
			top: 3px;
			width: 22px;
			height: 22px;
			border-radius: 50%;
			background: #fff;
		}
		.tag-test {
			background: #8a5200;
			color: #ffd595;
			border-radius: 8px;
			padding: 3px 8px;
			font-size: 12px;
			font-weight: 800;
		}
		@media (max-width: 760px) {
			.grid { grid-template-columns: 1fr; }
			.head { flex-direction: column; align-items: flex-start; }
			.title { font-size: 34px; }
		}
	</style>
</head>
<body>
	<div class="wrap">
		<div class="logo-box">Pay</div>
		<div class="card">
			<div class="head">
				<div>
					<h1 class="title">Configuración Recurrente</h1>
					<details class="help">
						<summary>Dónde encuentro las llaves?</summary>
						<p class="sub">En tu cuenta Recurrente, sección de API Keys. Usa llaves de prueba para modo TEST.</p>
					</details>
				</div>
				<div id="sub-status-pill" class="pill warn">Validando...</div>
			</div>

			<div class="body">
				<div id="status-box" class="status warn">Verificando suscripción de la sub-cuenta...</div>

				<div class="field">
					<label>Location ID (GHL)</label>
					<input id="location-id" type="text" placeholder="Se detecta automáticamente" />
					<div class="muted">Si no se detecta solo, puedes pegarlo manualmente y presionar "Validar suscripción".</div>
				</div>

				<div id="inactive-panel" class="hidden">
					<hr class="divider" />
					<div class="field">
						<label>Código/ID de Activación (opcional)</label>
						<input id="activation-code" type="text" placeholder="Ingresa tu código y luego valida" />
					</div>
					<div class="actions">
						<button class="btn-primary" id="btn-activate">Guardar y validar</button>
						<a id="buy-sub-link" class="btn-soft" href="#" target="_top">Comprar/Reactivar suscripción</a>
					</div>
					<div class="muted">Si ya compraste o reactivaste, presiona "Validar suscripción" para habilitar esta pantalla.</div>
				</div>

				<div id="active-panel" class="hidden">
					<hr class="divider" />
					<h3 style="margin:0 0 10px; font-size: 32px;">Llaves de Recurrente</h3>
					<div class="test-box">
					<div class="grid">
						<div class="field">
							<label>Nombre comercial</label>
							<input id="business-name" type="text" placeholder="Ej: Nexus" />
						</div>
						<div class="field">
							<label>Modo</label>
							<input value="test" disabled />
						</div>
						<div class="field">
							<label>Public Key (test)</label>
							<input id="public-key" type="text" placeholder="pk_test_..." />
						</div>
						<div class="field">
							<label>Secret Key (test)</label>
							<input id="secret-key" type="password" placeholder="sk_test_..." />
						</div>
					</div>
					</div>
					<div class="mode-row">
						<div class="switch"></div>
						<div style="font-weight:700;">Modo LIVE</div>
						<span class="tag-test">TEST</span>
					</div>
					<div class="muted">Modo actual: <strong>TEST</strong> - se usan las llaves de prueba.</div>
					<div class="actions">
						<button class="btn-primary" id="btn-save-keys">Guardar configuración</button>
						<button class="btn-soft" id="btn-recheck">Validar suscripción</button>
					</div>
					<div class="muted">Las llaves se guardan por sub-cuenta (location_id).</div>
				</div>

				<div id="message" class="message"></div>
			</div>
		</div>
	</div>

	<script>
		const WORKER = window.location.origin;
		const WP_STORE = 'https://pagos.epic.gt';

		function setMsg(msg, ok) {
			const el = document.getElementById('message');
			el.textContent = msg || '';
			el.className = 'message ' + (msg ? (ok ? 'msg-ok' : 'msg-err') : '');
		}

		function setStatus(active, text) {
			const box = document.getElementById('status-box');
			const pill = document.getElementById('sub-status-pill');
			if (active) {
				box.className = 'status ok';
				pill.className = 'pill ok';
				pill.textContent = 'Suscripción activa';
			} else {
				box.className = 'status warn';
				pill.className = 'pill warn';
				pill.textContent = 'Suscripción inactiva';
			}
			box.textContent = text;
		}

		function detectLocationId() {
			const q = new URLSearchParams(window.location.search);
			const fromQuery = q.get('locationId') || q.get('location_id');
			if (fromQuery) return fromQuery;

			const fromStorage = localStorage.getItem('ghl_location_id');
			if (fromStorage) return fromStorage;

			const ref = document.referrer || '';
			try {
				if (ref) {
					const refUrl = new URL(ref);
					const parts = refUrl.pathname.split('/').filter(Boolean);
					const idx = parts.indexOf('location');
					if (idx >= 0 && parts[idx + 1]) {
						const candidate = parts[idx + 1];
						if (/^[a-zA-Z0-9_-]{5,60}$/.test(candidate)) {
							return candidate;
						}
					}
				}
			} catch (_) {}

			return '';
		}

		async function checkSubscription(locationId) {
			const res = await fetch(WORKER + '/api/check-subscription?locationId=' + encodeURIComponent(locationId));
			return res.json();
		}

		async function loadTenant(locationId) {
			try {
				const res = await fetch(WORKER + '/admin/tenant?locationId=' + encodeURIComponent(locationId));
				const data = await res.json();
				if (data.success && data.tenant) {
					document.getElementById('business-name').value = data.tenant.business_name || '';

					const publicInput = document.getElementById('public-key');
					const secretInput = document.getElementById('secret-key');

					if (data.tenant.recurrente_public_key) {
						publicInput.value = data.tenant.recurrente_public_key;
					}

					if (data.tenant.recurrente_secret_key) {
						secretInput.value = '';
						secretInput.placeholder = data.tenant.recurrente_secret_key;
					}

					setMsg('Ya existe configuración previa para esta sub-cuenta. Las llaves se muestran enmascaradas por seguridad.', true);
				}
			} catch (_) {}
		}

		function syncBuyLink(locationId) {
			const link = document.getElementById('buy-sub-link');
			link.href = WP_STORE + '/checkout/?account_id=' + encodeURIComponent(locationId) + '&open-subscription=1';
		}

		async function renderByStatus(locationId) {
			const result = await checkSubscription(locationId);
			const active = !!(result && result.success && result.active);

			if (active) {
				setStatus(true, 'Tu sub-cuenta tiene suscripción activa. Ya puedes configurar llaves.');
				document.getElementById('inactive-panel').classList.add('hidden');
				document.getElementById('active-panel').classList.remove('hidden');
				await loadTenant(locationId);
			} else {
				setStatus(false, 'No encontramos suscripción activa para esta sub-cuenta.');
				document.getElementById('active-panel').classList.add('hidden');
				document.getElementById('inactive-panel').classList.remove('hidden');
			}
		}

		async function activateAndValidate() {
			const locationId = document.getElementById('location-id').value.trim();
			const code = document.getElementById('activation-code').value.trim();
			if (!locationId) {
				setMsg('Falta location ID.', false);
				return;
			}

			if (code) {
				const res = await fetch(WORKER + '/app/activate-code', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ code, locationId }),
				});
				const data = await res.json();
				if (!data.success) {
					setMsg(data.error || 'No se pudo activar el código.', false);
					return;
				}
				setMsg('Código activado. Verificando suscripción...', true);
			}

			await renderByStatus(locationId);
		}

		async function saveKeys() {
			const locationId = document.getElementById('location-id').value.trim();
			const businessName = document.getElementById('business-name').value.trim();
			const publicKey = document.getElementById('public-key').value.trim();
			const secretKey = document.getElementById('secret-key').value.trim();

			if (!locationId || !publicKey || !secretKey) {
				setMsg('Completa location ID, public key y secret key.', false);
				return;
			}

			const res = await fetch(WORKER + '/admin/tenant', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ locationId, businessName, publicKey, secretKey }),
			});
			const data = await res.json();

			if (data.success) {
				setMsg('Llaves guardadas correctamente.', true);
				document.getElementById('secret-key').value = '';
				await loadTenant(locationId);
			} else {
				setMsg(data.error || 'No se pudieron guardar las llaves.', false);
			}
		}

		async function init() {
			const locationId = detectLocationId();
			const input = document.getElementById('location-id');
			input.value = locationId;

			if (!locationId) {
				setStatus(false, 'No pudimos detectar automáticamente tu location ID. Pégalo manualmente para continuar.');
				document.getElementById('inactive-panel').classList.remove('hidden');
				return;
			}

			localStorage.setItem('ghl_location_id', locationId);
			syncBuyLink(locationId);
			await renderByStatus(locationId);
		}

		document.getElementById('btn-activate').addEventListener('click', activateAndValidate);
		document.getElementById('btn-save-keys').addEventListener('click', saveKeys);
		document.getElementById('btn-recheck').addEventListener('click', async () => {
			const locationId = document.getElementById('location-id').value.trim();
			if (!locationId) return setMsg('Falta location ID.', false);
			await renderByStatus(locationId);
		});

		init().catch((e) => setMsg('Error inicializando configuración: ' + (e.message || e), false));
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
		return router.handle(request, env);
	},
} satisfies ExportedHandler<Env>;
