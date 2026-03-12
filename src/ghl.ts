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
import { getGhlToken } from './db';
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
 */
export async function handlePaymentsUrl(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const workerUrl = new URL(request.url).origin;
    const refererHeader = request.headers.get('Referer') || '';
    const userAgent = request.headers.get('User-Agent') || '';

    // Safely encode variables for the script
    const safeWorkerUrl = JSON.stringify(workerUrl);
    const safeReferer = JSON.stringify(refererHeader);
    const safeUserAgent = JSON.stringify(userAgent);

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
      align-items: center; justify-content: center;
      min-height: 100vh; background: #f8f9fa; color: #333;
    }
    .container { text-align: center; padding: 2rem; width: 100%; max-width: 500px; }
    .spinner {
      width: 48px; height: 48px; border: 4px solid #e9ecef; border-top-color: #4263eb;
      border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #6c757d; font-size: 0.9rem; }
    .error { color: #e03131; display: none; margin-top: 1rem; }
    #debug-box {
      max-height: 300px; overflow-y: auto; border: 1px solid #dee2e6;
      background: #f1f3f5; color: #495057; padding: 12px; border-radius: 8px;
      margin-top: 2rem; font-family: monospace; font-size: 11px;
      text-align: left; white-space: pre-wrap; word-break: break-all;
    }
    #manual-form {
      display: none; margin-top: 2rem; padding: 1.5rem;
      background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    #manual-form.show { display: block; }
    #manual-form input {
      width: 100%; padding: 0.75rem; margin: 0.5rem 0 1rem;
      border: 1px solid #ced4da; border-radius: 4px;
    }
    #manual-form button {
      width: 100%; padding: 0.75rem; background: #4263eb; color: white;
      border: none; border-radius: 4px; cursor: pointer; font-weight: 600;
    }
    #manual-form label { display: block; text-align: left; font-size: 0.85rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h2 id="status-text">Detectando factura...</h2>
    <p id="status-sub">Buscando detalles de pago en GoHighLevel</p>
    <p class="error" id="error-msg"></p>
    
    <form id="manual-form" onsubmit="return false;">
      <h3 style="margin-bottom: 1rem;">Pago Manual</h3>
      <label>Factura / Charge ID:</label>
      <input type="text" id="chargeId-input" required placeholder="ID de factura">
      <label>Monto (GTQ):</label>
      <input type="number" id="amount-input" step="0.01" required placeholder="0.00">
      <label>Email:</label>
      <input type="email" id="email-input" required placeholder="tu@email.com">
      <button type="submit" id="submit-btn" onclick="submitManual()">Generar Link de Pago</button>
    </form>
    
    <pre id="debug-box"></pre>
  </div>

  <script>
    const WORKER_URL = ${safeWorkerUrl};
    const REFERER = ${safeReferer};
    const USER_AGENT = ${safeUserAgent};

    function log(label, data) {
      const box = document.getElementById('debug-box');
      if (box) {
        const time = new Date().toLocaleTimeString();
        box.textContent += '[' + time + '] ' + label + ': ' + (typeof data === 'object' ? JSON.stringify(data) : data) + '\\n';
        box.scrollTop = box.scrollHeight;
      }
      console.log(label, data);
    }

    function extractId(text) {
      if (!text) return null;
      // Match UUID patterns or invoice paths
      const m = text.match(/\\/invoice\\/([a-zA-Z0-9-]+)/) || text.match(/invoiceId=([a-zA-Z0-9-]+)/);
      return m ? m[1] : null;
    }

    async function start() {
      log('Iframe Init', { url: location.href, referer: REFERER });
      
      const urlParams = new URLSearchParams(location.search);
      const chargeId = urlParams.get('chargeId') || extractId(location.href) || extractId(REFERER);
      const locationId = urlParams.get('locationId') || localStorage.getItem('ghl_location_id');
      const amount = urlParams.get('amount') || '';

      log('Detection results', { chargeId, locationId, amount });

      if (chargeId && locationId) {
        if (amount && !amount.includes('{')) {
           log('Processing with URL data', { chargeId, amount });
           await createCheckout({ chargeId, locationId, amount, name: urlParams.get('name'), email: urlParams.get('contactEmail') });
        } else {
           log('Fetching full details from server...', { chargeId, locationId });
           await createCheckout({ chargeId, locationId, amount: '{amount}' }); // Server will resolve {amount}
        }
      } else {
        log('Missing required data, showing form', { chargeId, locationId });
        showManual();
      }
    }

    async function createCheckout(payload) {
      try {
        document.getElementById('status-text').textContent = 'Creando link de pago...';
        const res = await fetch(WORKER_URL + '/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
            let raw = event.data;
            showDebug('🔍 Raw event.data (type: ' + (typeof raw) + ')', raw);

            // Try to parse if it's a string
            if (typeof raw === 'string') {
              try { 
                raw = JSON.parse(raw);
                showDebug('✅ Successfully parsed JSON string', raw);
              } catch(e) { 
                showDebug('⚠️ Could not parse as JSON', { error: e.message, original: raw });
              }
            }

            // Defensive clone/helper to convert Proxy-like objects into plain POJOs
            function cloneData(obj) {
              try {
                // Prefer structuredClone if available
                if (typeof structuredClone === 'function') return structuredClone(obj);
              } catch (e) {
                // ignore
              }
              try {
                return JSON.parse(JSON.stringify(obj));
              } catch (e) {
                // Try manual shallow copy
                try {
                  const out = {};
                  for (const k of Object.keys(obj || {})) {
                    out[k] = obj[k];
                  }
                  // include symbol/hidden keys if possible
                  try { for (const k of Reflect.ownKeys(obj || {})) { if (!(k in out)) out[k] = obj[k]; } } catch(e){}
                  return out;
                } catch (err) {
                  return obj;
                }
              }
            }

            const payload = cloneData(raw?.data || raw?.payload || raw);
            showDebug('📦 Final payload extracted', { 
              keys: payload ? Object.keys(payload) : 'null',
              payload: payload 
            });

            // Attempt to find chargeId in several places, including nested 'invoice' objects
            let chargeId = payload?.chargeId || payload?.charge_id || payload?.id || payload?.chargeID;
            if (!chargeId && payload && payload.invoice) {
              chargeId = payload.invoice._id || payload.invoice.id || payload.invoice.invoiceNumber || null;
            }
            showDebug('🔑 Looking for chargeId', { found: !!chargeId, value: chargeId });

            // If chargeId not found at top-level, but payload looks like an invoice object, map fields
            if (!chargeId && payload && payload.invoice) {
              const inv = payload.invoice;
              const item = Array.isArray(inv.invoiceItems) && inv.invoiceItems.length ? inv.invoiceItems[0] : null;
              const mapped = {
                chargeId: inv._id || inv.invoiceNumber || ((inv.altId || 'unknown') + '-' + Date.now()),
                amount: inv.total || inv.invoiceTotal || inv.amountDue || (item ? item.amount : null),
                currency: inv.currency || (item ? item.currency : null) || 'GTQ',
                contactName: inv.contactDetails?.name || inv.contactDetails?.companyName || '',
                contactEmail: inv.contactDetails?.email || '',
                description: item ? item.name || item.description || inv.name || 'Pago GHL' : inv.name || 'Pago GHL',
                locationId: inv.altId || payload.layout?.altId || null
              };
              showDebug('🧭 Detected nested invoice object - mapped payload', mapped);
              // Validate amount
              if (mapped.amount && Number(mapped.amount) > 0) {
                processPayment(mapped);
                return;
              } else {
                showDebug('⚠️ Invoice found but amount invalid', { amount: mapped.amount });
                // continue to other checks / waiting
                return;
              }
            }

            if (!chargeId) {
              showDebug('❌ No chargeId found in this message - continuing to listen...', { payload_type: typeof payload });
              return;
            }

            showDebug('✅ Found chargeId! Processing payment...', { chargeId });
            processPayment({ ...payload, chargeId });
          });

            // If we have locationId, try to fetch pending charge from server
          if (possibleLocationId) {
            showDebug('📡 Attempting to fetch pending charge from server...', { locationId: possibleLocationId });
            
            try {
              const queryResponse = await fetch(WORKER_URL + '/api/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'get_pending_charge',
                  locationId: possibleLocationId,
                  action: 'get_pending_charge'
                })
              });

              const queryResult = await queryResponse.json();
              showDebug('✅ Query response received', queryResult);

                if (queryResult.success && queryResult.chargeId) {
                showDebug('🎯 Got pending charge from server', queryResult);
                processPayment({
                  chargeId: queryResult.chargeId,
                  amount: queryResult.amount,
                  currency: queryResult.currency || 'GTQ',
                  locationId: possibleLocationId
                });
              } else {
                showDebug('⚠️ Query returned but no charge found', queryResult);
              }
            } catch (err) {
              showDebug('❌ Error fetching from query endpoint', { error: err.message });
            }
          }

          // Request charge data from GHL parent as backup
          showDebug('📤 Requesting charge data from GHL parent...', {});
          window.parent.postMessage({ type: 'REQUEST_PAYMENT_DATA', action: 'get_charge' }, '*');
          showDebug('Sent: REQUEST_PAYMENT_DATA', {});
          window.parent.postMessage({ action: 'get_charge', data: {} }, '*');
          showDebug('Sent: get_charge request', {});

          // Also announce readiness to GHL
          showDebug('📢 Sending PAYMENT_PROVIDER_READY signals...', {});
          window.parent.postMessage(JSON.stringify({ type: 'PAYMENT_PROVIDER_READY' }), '*');
          showDebug('📤 Sent format #1', { type: 'PAYMENT_PROVIDER_READY' });
          window.parent.postMessage(JSON.stringify({ eventType: 'PAYMENT_PROVIDER_READY' }), '*');
          showDebug('📤 Sent format #2', { eventType: 'PAYMENT_PROVIDER_READY' });
          window.parent.postMessage({ type: 'PAYMENT_PROVIDER_READY' }, '*');
          showDebug('📤 Sent format #3 (object)', { type: 'PAYMENT_PROVIDER_READY' });

          // Timeout warning
          setTimeout(() => {
            if (messageCount === 0) {
              showDebug('⚠️ TIMEOUT: No messages received after 10 seconds', { 
                check: 'GHL Custom Providers may not support postMessage data passing',
                suggestion: 'Showing manual payment form as fallback'
              });
              
              // Hide spinner and show manual form
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('status-text').textContent = 'Formulario de Pago Manual';
              document.getElementById('status-sub').textContent = 'GHL no está enviando los datos automáticamente. Por favor completa los datos de pago:';
              document.getElementById('manual-form').classList.add('show');
            }
          }, 10000);
        }
      } catch (initErr) {
        showDebug('❌ Error during initialization', { error: initErr.message, stack: initErr.stack });
      }
    })();

    // Handle manual form submission
    document.getElementById('submit-btn').addEventListener('click', function(e) {
      e.preventDefault();
      const formData = {
        chargeId: document.getElementById('chargeId-input').value,
        amount: parseFloat(document.getElementById('amount-input').value),
        contactEmail: document.getElementById('email-input').value,
        contactName: document.getElementById('name-input').value,
        currency: 'GTQ'
      };
      
      document.getElementById('manual-form').classList.remove('show');
      processPayment(formData);
    });
  </script>
</body>
</html`;

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
        amount: any; // Allow any type to handle placeholders
        currency?: string;
        contactName?: string;
        contactEmail?: string;
        description?: string;
    }>();

    let finalAmount = body.amount;
    let finalLocationId = body.locationId;
    let finalContactEmail = body.contactEmail;
    let finalContactName = body.contactName;
    let finalDescription = body.description;

    const isPlaceholder = (v: any) => typeof v === 'string' && v.includes('{');

    if (!finalLocationId || !body.chargeId || isPlaceholder(finalAmount)) {
        // If amount is missing/placeholder, we MUST have locationId to fetch from GHL
        if (!finalLocationId) {
            return jsonResponse({ success: false, error: 'Missing locationId — cannot resolve invoice without it' }, 400);
        }

        // Try to fetch real invoice data from GHL
        try {
            const ghlTokenRow = await getGhlToken(env.DB, finalLocationId);
            if (ghlTokenRow) {
                const gToken = (ghlTokenRow as any).access_token;
                const gResp = await fetch(`https://services.leadconnectorhq.com/payments/invoices/${body.chargeId}?locationId=${finalLocationId}`, {
                    headers: {
                        'Authorization': `Bearer ${gToken}`,
                        'Version': '2021-07-28'
                    }
                });
                if (gResp.ok) {
                    const gData = await gResp.json() as any;
                    const inv = gData.invoice;
                    if (inv) {
                        finalAmount = inv.total || inv.amountDue;
                        finalContactEmail = finalContactEmail || inv.contactDetails?.email;
                        finalContactName = finalContactName || inv.contactDetails?.name || inv.contactDetails?.companyName;
                        if (!finalDescription || isPlaceholder(finalDescription)) {
                            const item = inv.invoiceItems?.[0];
                            finalDescription = item?.name || item?.description || inv.name || 'Pago GHL';
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to resolve GHL invoice server-side:', e);
        }
    }

    if (!finalLocationId || !body.chargeId || !finalAmount || isPlaceholder(finalAmount)) {
        return jsonResponse({ 
            success: false, 
            error: `Could not resolve valid payment details. Amount: ${finalAmount}`,
            resolvedAmount: finalAmount,
            locationId: finalLocationId
        }, 400);
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
            amount_in_cents: toCents(finalAmount),
            currency: body.currency || 'GTQ',
            product_name: finalDescription || 'Pago GHL',
            success_url: successUrl,
            cancel_url: cancelUrl,
            email: finalContactEmail,
            metadata: {
                ghl_charge_id: body.chargeId,
                ghl_location_id: finalLocationId,
                contact_name: finalContactName || '',
            },
        }
    );

    // 4. Log the transaction
    await createTransaction(env.DB, {
        location_id: finalLocationId,
        ghl_charge_id: body.chargeId,
        recurrente_checkout_id: checkout.id,
        amount: Number(finalAmount),
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
    try {
        const body = await request.json<GHLQueryAction>();

        console.log('[queryUrl] Received action:', JSON.stringify(body, null, 2));

        const { type, locationId } = body;

        if (!type) {
          return jsonResponse({ success: false, error: 'Missing type' }, 400);
        }

        // Custom helper: get pending charge created by webhook
        if (type === 'get_pending_charge') {
          const chargeId = (body as any).chargeId || (body as any).id || null;
          // If chargeId provided, try to return the matching transaction
          if (chargeId) {
            const tx = await getTransactionByChargeId(env.DB, chargeId);
            if (!tx) return jsonResponse({ success: false, message: 'No transaction found', chargeId }, 404);
            const meta = typeof tx.meta === 'string' ? JSON.parse(tx.meta || '{}') : tx.meta || {};
/* 
            return jsonResponse({ success: true, chargeId, amount: (tx.amount || 0) / 100, currency: tx.currency, checkout_url: meta.recurrente_checkout_url || null });
*/
            // Fixing the lint error by ensuring tx.amount is treated as a number
            const txAmount = typeof tx.amount === 'number' ? tx.amount : 0;
            return jsonResponse({ success: true, chargeId, amount: txAmount / 100, currency: tx.currency, checkout_url: meta.recurrente_checkout_url || null });
          }

          // Otherwise, require a locationId to lookup pending transaction
          if (!locationId) {
            return jsonResponse({ success: false, error: 'Missing locationId or chargeId' }, 400);
          }

          // Return the latest pending transaction for this location
          const { results } = await env.DB.prepare('SELECT * FROM transactions WHERE location_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').bind(locationId, 'pending').all();
          const row = results && results.length ? results[0] : null;
          if (!row) return jsonResponse({ success: false, message: 'No pending charges' });
          const meta = typeof row.meta === 'string' ? JSON.parse(row.meta || '{}') : row.meta || {};
/* 
          return jsonResponse({ success: true, chargeId: row.ghl_charge_id, amount: (row.amount || 0) / 100, currency: row.currency, checkout_url: meta.recurrente_checkout_url || null });
*/
          const rowAmount = typeof row.amount === 'number' ? row.amount : 0;
          return jsonResponse({ success: true, chargeId: row.ghl_charge_id, amount: rowAmount / 100, currency: row.currency, checkout_url: meta.recurrente_checkout_url || null });
        }

/* 
        // Global pending charge (no locationId) - useful when iframe cannot get locationId
        // DISABLED: Security risk in multi-tenant environments
        if (type === 'get_pending_charge_global') {
          const { results } = await env.DB.prepare('SELECT * FROM transactions WHERE status = ? ORDER BY created_at DESC LIMIT 1').bind('pending').all();
          const row = results && results.length ? results[0] : null;
          if (!row) return jsonResponse({ success: false, message: 'No pending charges found globally' });
          const meta = typeof row.meta === 'string' ? JSON.parse(row.meta || '{}') : row.meta || {};
          return jsonResponse({ success: true, chargeId: row.ghl_charge_id, amount: (row.amount || 0) / 100, currency: row.currency, checkout_url: meta.recurrente_checkout_url || null, locationId: row.location_id });
        }

        if (type === 'ensure_checkout_global') {
          // Try each stored GHL token and associated location to find pending charges and create checkout
          const tokens = await env.DB.prepare('SELECT * FROM ghl_tokens').all();
          const rows: any[] = tokens.results || [];
          for (const t of rows) {
            try {
              const locationId = t.location_id;
              const tenant = await getTenant(env.DB, locationId);
              if (!tenant) continue;
              // Reuse ensureCheckoutForLocation logic by calling it
              const res = await ensureCheckoutForLocation(env, tenant, { locationId });
              const text = await res.text();
              try {
                const parsed = JSON.parse(text);
                if (parsed && parsed.success && parsed.checkout_url) return jsonResponse(parsed);
              } catch (e) {
                continue;
              }
            } catch (e) {
              console.error('[ensure_checkout_global] error for token', t.location_id, e instanceof Error ? e.message : 'Unknown error');

              continue;
            }
          }
          return jsonResponse({ success: false, error: 'No pending charges found across all locations' }, 404);
        }
*/

        // Health check / capability validation
        if (type === 'health' || type === 'ping' || type === 'capabilities') {
            return jsonResponse({
                success: true,
                capabilities: ['payments', 'verify'],
                message: 'EPICPay1 provider is active and ready'
            });
        }

        // Look up tenant
        const tenant = await getTenant(env.DB, locationId);
        if (!tenant) {
            return jsonResponse({ success: false, error: 'Tenant not found' }, 404);
        }

        switch (type) {
          case 'ensure_checkout':
            // Ensure there's a Recurrente checkout for the latest pending charge in GHL for this location
            return ensureCheckoutForLocation(env, tenant, body);

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
    } catch (error) {
        console.error('[queryUrl] Error:', error);
        return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
}

  async function ensureCheckoutForLocation(env: Env, tenant: any, body: any): Promise<Response> {
    const locationId = body.locationId;
    if (!locationId) return jsonResponse({ success: false, error: 'Missing locationId for ensure_checkout' }, 400);

    // 1. Get GHL token for this location
    const tokenRow = await getGhlToken(env.DB, locationId);
    if (!tokenRow || !tokenRow.access_token) {
        return jsonResponse({ success: false, error: 'No GHL token found for location' }, 404);
    }
    const ghltoken = tokenRow.access_token;

    // 2. Get invoiceId/chargeId from request
    const invoiceId = body.invoiceId || body.chargeId || null;
    if (!invoiceId) {
        return jsonResponse({ success: false, error: 'Missing invoiceId or chargeId in request' }, 400);
    }

    // 3. Fetch complete invoice from GHL API
    let invoice: any;
    try {
        const invoiceResponse = await fetch(`https://services.leadconnectorhq.com/invoices/${invoiceId}?locationId=${locationId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${ghltoken}`, 'Version': '2021-07-28' }
        });
        if (!invoiceResponse.ok) {
            throw new Error(`Failed to fetch invoice: ${invoiceResponse.statusText}`);
        }
        invoice = await invoiceResponse.json();
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return jsonResponse({ success: false, error: `Error fetching invoice: ${errorMessage}` }, 500);
    }

    // 4. Extract fields from complete invoice
    const item = Array.isArray(invoice.invoiceItems) && invoice.invoiceItems.length ? invoice.invoiceItems[0] : null;
    const chargeId = invoice._id || invoice.invoiceNumber || `${invoice.altId || 'unknown'}-${Date.now()}`;
    const amount = invoice.total || invoice.invoiceTotal || invoice.amountDue || (item ? item.amount : null);
    const currency = invoice.currency || (item ? item.currency : null) || 'GTQ';
    const contactEmail = invoice.contactDetails?.email || '';
    const contactName = invoice.contactDetails?.name || invoice.contactDetails?.companyName || '';
    const description = item ? item.name || item.description || invoice.name || 'Pago GHL' : invoice.name || 'Pago GHL';

    if (!amount || amount <= 0) {
        return jsonResponse({ success: false, error: 'Invalid amount in invoice' }, 422);
    }

    const amountCents = Math.round(amount * 100);

    // 5. Check if transaction with this exact chargeId already exists
    const existing = await env.DB.prepare('SELECT * FROM transactions WHERE ghl_charge_id = ? AND location_id = ? AND status = ? LIMIT 1')
        .bind(chargeId, locationId, 'pending')
        .first();

    if (existing) {
        const meta = typeof existing.meta === 'string' ? JSON.parse(existing.meta || '{}') : existing.meta || {};
        
        // If amount matches, return existing checkout
        if (existing.amount === amountCents && meta.recurrente_checkout_url) {
            console.log(`[ensureCheckoutForLocation] Returning existing checkout for chargeId: ${chargeId}, amount: ${amountCents}`);
            return jsonResponse({ 
                success: true, 
                checkout_url: meta.recurrente_checkout_url, 
                checkout_id: existing.recurrente_checkout_id,
                chargeId,
                source: 'existing'
            });
        }
        
        // If amount differs, log and create new checkout
        console.log(`[ensureCheckoutForLocation] Amount mismatch for chargeId ${chargeId}: existing=${existing.amount}, new=${amountCents}. Creating new checkout.`);
    }

    // 6. Create new Recurrente checkout for this invoice
    try {
        const checkout = await createCheckout(
            { publicKey: tenant.recurrente_public_key, secretKey: tenant.recurrente_secret_key },
            {
                amount_in_cents: amountCents,
                currency,
                product_name: description,
                success_url: `${new URL('https://recurrente-bridge.epicgt.workers.dev').origin}/payment/success?charge_id=${chargeId}`,
                cancel_url: `${new URL('https://recurrente-bridge.epicgt.workers.dev').origin}/payment/cancel?charge_id=${chargeId}`,
                email: contactEmail,
                metadata: { ghl_charge_id: chargeId, ghl_location_id: locationId }
            }
        );

        // Persist transaction (insert or update)
        if (existing) {
            // Update existing transaction with new checkout URL
            await updateTransactionByChargeId(env.DB, chargeId, 'pending', checkout.id);
            // Note: The previous call was trying to pass an object where a string was expected.
            // Based on db.ts: updateTransactionByChargeId(db, chargeId, status, paymentId)
            console.log(`[ensureCheckoutForLocation] Updated transaction for chargeId: ${chargeId}`);
        } else {
            // Create new transaction
            await createTransaction(env.DB, {
                location_id: locationId,
                ghl_charge_id: chargeId,
                recurrente_checkout_id: checkout.id,
                amount: amountCents,
                currency,
                status: 'pending',
                meta: { recurrente_checkout_url: checkout.checkout_url }
            });
            console.log(`[ensureCheckoutForLocation] Created new transaction for chargeId: ${chargeId}`);
        }

        return jsonResponse({ 
            success: true, 
            checkout_url: checkout.checkout_url, 
            checkout_id: checkout.id, 
            chargeId,
            source: existing ? 'updated' : 'created'
        });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        return jsonResponse({ success: false, error: `Failed to create checkout: ${errorMessage}` }, 500);
    }
  }

// Ensure arithmetic operations handle non-numeric values
function safeDivideAmount(amount: any): number {
    return typeof amount === 'number' ? amount / 100 : 0;
}
