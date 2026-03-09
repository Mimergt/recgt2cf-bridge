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
	const code = params.get('code');

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
			const accessToken = tokenData.access_token;
			const locationId = tokenData.locationId;

			// 2. Configure the Custom Payment Provider URLs automatically via API!
			if (accessToken && locationId) {
				const providerResponse = await fetch('https://services.leadconnectorhq.com/payments/custom-provider/provider', {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${accessToken}`,
						'Version': '2021-07-28',
						'Content-Type': 'application/json',
						'Location-Id': locationId
					},
					body: JSON.stringify({
						name: 'Recurrente',
						description: 'Integración oficial de Recurrente puenteada en Cloudflare Worker',
						paymentUrls: {
							paymentsUrl: 'https://recurrente-bridge.epicgt.workers.dev/payment',
							queryUrl: 'https://recurrente-bridge.epicgt.workers.dev/api/query'
						}
					})
				});

				const providerResponseText = await providerResponse.text();
				if (!providerResponse.ok) {
					console.error('Provider API Error:', providerResponseText);
					throw new Error('Fallo al registrar las URLs de pago: ' + providerResponseText);
				}

				successMessage = '¡Las URLs de pago y del puente se configuraron automáticamente con la API v2 de GHL!';
			} else {
				errorMessage = 'Se obtuvo el token, pero falta el Location ID para registrar las URLs.';
			}
		} catch (error) {
			console.error('OAuth Error:', error);
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	} else {
		errorMessage = 'No se recibió ningún código de autorización de GHL.';
	}

	const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Instalada</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8f9fa; color: #333; text-align: center; }
    .box { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
    h2 { color: ${errorMessage ? '#d32f2f' : '#2f9e44'}; }
    .error { color: #d32f2f; font-size: 0.9em; background: #ffebee; padding: 10px; border-radius: 4px; border: 1px solid #ffcdd2; margin-top: 15px; word-break: break-all; text-align: left; }
  </style>
</head>
<body>
  <div class="box">
    <h2>${errorMessage ? 'Hubo un problema' : '¡Conexión Exitosa!'}</h2>
    <p>${errorMessage ? 'No se pudo completar la configuración automática en GoHighLevel.' : successMessage}</p>
    ${errorMessage ? `<div class="error"><b>Detalle del error:</b><br>${errorMessage}</div>` : ''}
    <p style="margin-top:20px;">Ya puedes cerrar esta ventana y regresar a GHL.</p>
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
