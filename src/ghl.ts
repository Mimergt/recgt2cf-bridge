/**
 * GHL Handlers
 *
 * These handle the two main integration points with GoHighLevel:
 *
 * 1. paymentsUrl  → loaded in an iframe by GHL checkout
 *    - Receives payment details via query params or postMessage
 *    - Creates a Recurrente checkout session
 *    - Redirects the customer to pay
 *
 * 2. queryUrl → called server-to-server by GHL
 *    - Handles actions: verify, refund, subscription, etc.
 */

import type { Env, GHLQueryAction } from './types';
import { getTenant } from './db';
import { createCheckout, getCheckoutStatus, toCents } from './recurrente';
import { createTransaction, getTransactionByChargeId, updateTransactionByChargeId } from './db';
import { jsonResponse, htmlResponse } from './router';

// ─── paymentsUrl Handler ────────────────────────────────────

/**
 * This endpoint is loaded inside an iframe by GHL.
 * GHL sends payment data via postMessage event to the iframe.
 *
 * Flow:
 * 1. GHL loads this URL in iframe with locationId as param
 * 2. Page listens for postMessage with payment details
 * 3. Creates a Recurrente checkout
 * 4. Redirects to Recurrente checkout_url
 * 5. After payment, Recurrente redirects to success/cancel URL
 * 6. Success page sends postMessage back to GHL with result
 */
export async function handlePaymentsUrl(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    // Return the HTML page that GHL will load in the iframe
    const workerUrl = new URL(request.url).origin;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Procesando Pago</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f8f9fa;
      color: #333;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid #e9ecef;
      border-top-color: #4263eb;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h2 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #6c757d; font-size: 0.9rem; }
    .error { color: #e03131; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h2 id="status-text">Preparando checkout...</h2>
    <p id="status-sub">Serás redirigido a la página de pago</p>
    <p class="error" id="error-msg"></p>
  </div>

  <script>
    const WORKER_URL = '${workerUrl}';

    // Listen for payment data from GHL parent window
    window.addEventListener('message', async function(event) {
      console.log('[GHL Bridge] Received message:', event.data);

      // GHL sends event with type and payment data
      const data = event.data;
      if (!data || !data.chargeId) {
        console.log('[GHL Bridge] Ignoring non-payment message');
        return;
      }

      try {
        document.getElementById('status-text').textContent = 'Creando sesión de pago...';

        // Call our Worker to create a Recurrente checkout
        const response = await fetch(WORKER_URL + '/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locationId: data.locationId,
            chargeId: data.chargeId,
            amount: data.amount,
            currency: data.currency || 'GTQ',
            contactName: data.contactName || '',
            contactEmail: data.contactEmail || '',
            description: data.description || 'Pago GHL',
          }),
        });

        const result = await response.json();

        if (result.success && result.checkout_url) {
          document.getElementById('status-text').textContent = 'Redirigiendo a pago...';
          // Redirect the iframe to the Recurrente checkout page
          window.location.href = result.checkout_url;
        } else {
          throw new Error(result.error || 'Error al crear sesión de pago');
        }
      } catch (err) {
        console.error('[GHL Bridge] Error:', err);
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('status-text').textContent = 'Error al procesar';
        document.getElementById('error-msg').style.display = 'block';
        document.getElementById('error-msg').textContent = err.message;

        // Notify GHL of failure
        window.parent.postMessage({
          chargeId: data.chargeId,
          status: 'failed',
          error: err.message,
        }, '*');
      }
    });
  </script>
</body>
</html>`;

    return htmlResponse(html);
}

// ─── Payment Success Callback ───────────────────────────────

/**
 * Recurrente redirects here after successful payment.
 * We show a success page and notify GHL via postMessage.
 */
export async function handlePaymentSuccess(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const checkoutId = params.get('checkout_id') || params.get('session_id') || '';
    const chargeId = params.get('charge_id') || '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pago Exitoso</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f8f9fa;
      color: #333;
    }
    .container { text-align: center; padding: 2rem; }
    .check {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #2f9e44;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
      animation: scaleIn 0.3s ease-out;
    }
    .check svg { width: 32px; height: 32px; fill: white; }
    @keyframes scaleIn {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }
    h2 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #2f9e44; }
    p { color: #6c757d; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="check">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h2>¡Pago exitoso!</h2>
    <p>Tu pago ha sido procesado correctamente.</p>
  </div>
  <script>
    // Notify GHL parent that payment was successful
    window.parent.postMessage({
      chargeId: '${chargeId}',
      checkoutId: '${checkoutId}',
      status: 'succeeded',
    }, '*');
  </script>
</body>
</html>`;

    return htmlResponse(html);
}

/**
 * Recurrente redirects here if payment is cancelled.
 */
export async function handlePaymentCancel(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const chargeId = params.get('charge_id') || '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pago Cancelado</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f8f9fa;
      color: #333;
    }
    .container { text-align: center; padding: 2rem; }
    .icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #e03131;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .icon svg { width: 32px; height: 32px; fill: white; }
    h2 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #e03131; }
    p { color: #6c757d; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </div>
    <h2>Pago cancelado</h2>
    <p>El proceso de pago fue cancelado.</p>
  </div>
  <script>
    window.parent.postMessage({
      chargeId: '${chargeId}',
      status: 'failed',
      error: 'Payment cancelled by user',
    }, '*');
  </script>
</body>
</html>`;

    return htmlResponse(html);
}

// ─── Create Checkout API ────────────────────────────────────

/**
 * Called by our paymentsUrl iframe page.
 * Creates a checkout session on Recurrente and returns the URL.
 */
export async function handleCreateCheckout(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const body = await request.json<{
        locationId: string;
        chargeId: string;
        amount: number;
        currency?: string;
        contactName?: string;
        contactEmail?: string;
        description?: string;
    }>();

    if (!body.locationId || !body.chargeId || !body.amount) {
        return jsonResponse({ success: false, error: 'Missing required fields: locationId, chargeId, amount' }, 400);
    }

    // 1. Look up tenant credentials
    const tenant = await getTenant(env.DB, body.locationId);
    if (!tenant) {
        return jsonResponse(
            { success: false, error: `No Recurrente configuration found for location: ${body.locationId}` },
            404
        );
    }

    // 2. Build success/cancel URLs
    const workerUrl = new URL(request.url).origin;
    const successUrl = `${workerUrl}/payment/success?charge_id=${body.chargeId}`;
    const cancelUrl = `${workerUrl}/payment/cancel?charge_id=${body.chargeId}`;

    // 3. Create Recurrente checkout
    const checkout = await createCheckout(
        {
            publicKey: tenant.recurrente_public_key,
            secretKey: tenant.recurrente_secret_key,
        },
        {
            amount_in_cents: toCents(body.amount),
            currency: body.currency || 'GTQ',
            product_name: body.description || 'Pago GHL',
            success_url: successUrl,
            cancel_url: cancelUrl,
            email: body.contactEmail,
            metadata: {
                ghl_charge_id: body.chargeId,
                ghl_location_id: body.locationId,
                contact_name: body.contactName || '',
            },
        }
    );

    // 4. Log the transaction
    await createTransaction(env.DB, {
        location_id: body.locationId,
        ghl_charge_id: body.chargeId,
        recurrente_checkout_id: checkout.id,
        amount: toCents(body.amount),
        currency: body.currency || 'GTQ',
        status: 'pending',
        meta: { recurrente_checkout_url: checkout.checkout_url },
    });

    return jsonResponse({
        success: true,
        checkout_id: checkout.id,
        checkout_url: checkout.checkout_url,
    });
}

// ─── queryUrl Handler ───────────────────────────────────────

/**
 * GHL calls this endpoint for server-side payment operations:
 * - verify: check if a payment was completed
 * - refund: process a refund (future)
 * - subscription: manage subscriptions (future)
 */
export async function handleQueryUrl(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const body = await request.json<GHLQueryAction>();

    console.log('[queryUrl] Received action:', JSON.stringify(body));

    const { type, locationId } = body;

    if (!type || !locationId) {
        return jsonResponse({ success: false, error: 'Missing type or locationId' }, 400);
    }

    // Look up tenant
    const tenant = await getTenant(env.DB, locationId);
    if (!tenant) {
        return jsonResponse({ success: false, error: 'Tenant not found' }, 404);
    }

    switch (type) {
        case 'verify':
            return handleVerify(env, tenant, body);

        case 'refund':
            // TODO: Implement refund via Recurrente API
            return jsonResponse({
                success: false,
                error: 'Refunds not yet implemented',
            }, 501);

        case 'subscription':
            // TODO: Implement subscription management
            return jsonResponse({
                success: false,
                error: 'Subscriptions not yet implemented',
            }, 501);

        default:
            return jsonResponse({
                success: false,
                error: `Unknown action type: ${type}`,
            }, 400);
    }
}

// ─── Verify Action ──────────────────────────────────────────

import type { Tenant } from './types';

async function handleVerify(
    env: Env,
    tenant: Tenant,
    action: GHLQueryAction
): Promise<Response> {
    const { chargeId } = action;

    if (!chargeId) {
        return jsonResponse({ success: false, error: 'Missing chargeId for verify' }, 400);
    }

    // Find the transaction
    const transaction = await getTransactionByChargeId(env.DB, chargeId);
    if (!transaction) {
        return jsonResponse({ success: false, error: 'Transaction not found' }, 404);
    }

    // If we already know it's completed, return cached status
    if (transaction.status === 'completed') {
        return jsonResponse({
            success: true,
            status: 'completed',
            transactionId: transaction.recurrente_payment_id || transaction.recurrente_checkout_id,
        });
    }

    // Otherwise, check with Recurrente
    if (transaction.recurrente_checkout_id) {
        try {
            const checkoutStatus = await getCheckoutStatus(
                {
                    publicKey: tenant.recurrente_public_key,
                    secretKey: tenant.recurrente_secret_key,
                },
                transaction.recurrente_checkout_id
            );

            const isPaid = checkoutStatus.status === 'paid' || checkoutStatus.status === 'completed';

            if (isPaid) {
                await updateTransactionByChargeId(
                    env.DB,
                    chargeId,
                    'completed',
                    checkoutStatus.payment_id
                );
            }

            return jsonResponse({
                success: true,
                status: isPaid ? 'completed' : checkoutStatus.status,
                transactionId: checkoutStatus.payment_id || transaction.recurrente_checkout_id,
            });
        } catch (error) {
            console.error('[verify] Error checking Recurrente:', error);
            return jsonResponse({
                success: true,
                status: transaction.status,
                transactionId: transaction.recurrente_checkout_id,
            });
        }
    }

    return jsonResponse({
        success: true,
        status: transaction.status,
    });
}
