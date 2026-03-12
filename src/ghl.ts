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
 */
export async function handlePaymentsUrl(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const workerUrl = new URL(request.url).origin;
    const refererHeader = request.headers.get('Referer') || '';

    // Safely encode variables for the script
    const safeWorkerUrl = JSON.stringify(workerUrl);
    const safeReferer = JSON.stringify(refererHeader);

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
      display: flex; align-items: center; justify-content: center;
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
      max-height: 250px; overflow-y: auto; border: 1px solid #dee2e6;
      background: #f1f3f5; color: #495057; padding: 10px; border-radius: 6px;
      margin-top: 1.5rem; font-family: monospace; font-size: 10px;
      text-align: left; white-space: pre-wrap; word-break: break-all;
    }
    #manual-form {
      display: none; margin-top: 2rem; padding: 1.5rem;
      background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    #manual-form.show { display: block; }
    #manual-form input {
      width: 100%; padding: 0.65rem; margin: 0.4rem 0 0.8rem;
      border: 1px solid #ced4da; border-radius: 4px;
    }
    #manual-form button {
      width: 100%; padding: 0.75rem; background: #4263eb; color: white;
      border: none; border-radius: 4px; cursor: pointer; font-weight: 600;
    }
    #manual-form label { display: block; text-align: left; font-size: 0.8rem; font-weight: 600; }
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
      <input type="text" id="id-in" required placeholder="ID de factura">
      <label>Monto (GTQ):</label>
      <input type="number" id="amt-in" step="0.01" required placeholder="0.00">
      <label>Email:</label>
      <input type="email" id="em-in" required placeholder="tu@email.com">
      <button type="submit" onclick="submitMan()">Generar Link</button>
    </form>
    
    <pre id="debug-box"></pre>
  </div>

  <script>
    const WORKER = ${safeWorkerUrl};
    const REF = ${safeReferer};

    function log(m, d) {
      const b = document.getElementById('debug-box');
      if (b) {
        b.textContent += '[' + new Date().toLocaleTimeString() + '] ' + m + ': ' + (d ? JSON.stringify(d) : '') + '\\n';
        b.scrollTop = b.scrollHeight;
      }
      console.log(m, d);
    }

    function getID(t) {
      if (!t) return null;
      const m = t.match(/\\/invoice\\/([a-zA-Z0-9-]+)/) || t.match(/invoiceId=([a-zA-Z0-9-]+)/);
      return m ? m[1] : null;
    }

    async function init() {
      const docRef = document.referrer || '';
      log('Start', { url: location.href, headerRef: REF, docRef: docRef });
      
      const p = new URLSearchParams(location.search);
      
      // Try every possible source for the ID
      function findID() {
        return p.get('chargeId') || getID(location.href) || getID(REF) || getID(docRef) || null;
      }

      let cid = findID();
      let lid = p.get('locationId') || localStorage.getItem('ghl_location_id');
      let amt = p.get('amount') || '';

      // Success if we have real data from URL/Referrer
      if (cid && !cid.includes('{') && lid) {
        log('Auto-detected ID', cid);
        await go({ chargeId: cid, locationId: lid, amount: amt, email: p.get('contactEmail') });
        return;
      }

      log('Waiting for GHL (postMessage / Background)...');
      if (lid && lid !== 'null') localStorage.setItem('ghl_location_id', lid);

      // Listen for data from parent
      window.addEventListener('message', async (e) => {
        const raw = e.data;
        if (!raw) return;
        
        // Robust extraction from any object
        function extract(o) {
          if (!o || typeof o !== 'object') return null;
          // Try known paths
          const id = o.chargeId || o.id || o.invoiceId || (o.invoice && (o.invoice.id || o.invoice._id)) || (o.payload && o.payload.id);
          const loc = o.locationId || o.locId || lid;
          return id && !String(id).includes('{') ? { id, loc, amt: o.amount || o.total } : null;
        }

        let found = extract(raw) || extract(raw.payload) || extract(raw.data);
        
        // If it's a string, try parsing
        if (!found && typeof raw === 'string' && raw.includes('{')) {
          try { 
            const parsed = JSON.parse(raw);
            found = extract(parsed) || extract(parsed.payload) || extract(parsed.data);
          } catch(err) {}
        }

        if (found && found.id) {
          log('ID caught via MSG!', found.id);
          await go({ chargeId: found.id, locationId: found.loc || lid, amount: found.amt || '{amount}' });
        }
      });

      // Send multiple ping formats to trigger GHL data
      const pings = [
        { type: 'REQUEST_PAYMENT_DATA' },
        { action: 'get_charge' },
        { type: 'PAYMENT_PROVIDER_READY' },
        { event: 'ready' }
      ];
      pings.forEach(msg => {
        window.parent.postMessage(msg, '*');
        window.parent.postMessage(JSON.stringify(msg), '*');
      });
      
      log('Pings sent');

      setTimeout(() => {
        if (cid && !cid.includes('{')) {
           log('Timeout: Proceeding with found ID', cid);
           go({ chargeId: cid, locationId: lid || 'unknown', amount: amt || '{amount}' });
        } else {
           log('Timeout: No ID found, showing form');
           show();
        }
      }, 10000);
    }

    async function go(pay) {
      try {
        const r = await fetch(WORKER + '/api/create-checkout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pay)
        });
        const d = await r.json();
        if (d.success && d.checkout_url) {
          log('Redirect', d.checkout_url);
          window.top.location.href = d.checkout_url;
        } else throw new Error(d.error || 'Err');
      } catch (e) { log('Error', e.message); show(e.message); }
    }

    function show(e) {
      document.getElementById('spinner').style.display='none';
      document.getElementById('manual-form').classList.add('show');
      if (e) { const m=document.getElementById('error-msg'); m.textContent=e; m.style.display='block'; }
    }

    function submitMan() {
      const p = new URLSearchParams(location.search);
      const pay = {
        chargeId: document.getElementById('id-in').value,
        amount: document.getElementById('amt-in').value,
        contactEmail: document.getElementById('em-in').value,
        locationId: p.get('locationId') || localStorage.getItem('ghl_location_id')
      };
      if (!pay.locationId) { alert('Falta locationId'); return; }
      go(pay);
    }

    init();
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
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f8f9fa; color: #333;
    }
    .container { text-align: center; padding: 2rem; }
    .check {
      width: 64px; height: 64px; border-radius: 50%;
      background: #2f9e44; display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem; animation: scaleIn 0.3s ease-out;
    }
    .check svg { width: 32px; height: 32px; fill: white; }
    @keyframes scaleIn { from { transform: scale(0); } to { transform: scale(1); } }
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
    window.parent.postMessage({ chargeId: '${chargeId}', checkoutId: '${checkoutId}', status: 'succeeded' }, '*');
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
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f8f9fa; color: #333;
    }
    .container { text-align: center; padding: 2rem; }
    .icon {
      width: 64px; height: 64px; border-radius: 50%;
      background: #e03131; display: flex; align-items: center; justify-content: center;
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
    window.parent.postMessage({ chargeId: '${chargeId}', status: 'failed', error: 'Payment cancelled by user' }, '*');
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

        if (!type) return jsonResponse({ success: false, error: 'Missing type' }, 400);

        if (type === 'get_pending_charge') {
          const chargeId = (body as any).chargeId || (body as any).id || null;
          if (chargeId) {
            const tx = await getTransactionByChargeId(env.DB, chargeId);
            if (!tx) return jsonResponse({ success: false, message: 'No transaction found', chargeId }, 404);
            const meta = typeof tx.meta === 'string' ? JSON.parse(tx.meta || '{}') : tx.meta || {};
            const txAmount = typeof tx.amount === 'number' ? tx.amount : 0;
            return jsonResponse({ success: true, chargeId, amount: txAmount / 100, currency: tx.currency, checkout_url: meta.recurrente_checkout_url || null });
          }
          if (!locationId) return jsonResponse({ success: false, error: 'Missing locationId or chargeId' }, 400);

          const { results } = await env.DB.prepare('SELECT * FROM transactions WHERE location_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').bind(locationId, 'pending').all();
          const row = results && results.length ? results[0] : null;
          if (!row) return jsonResponse({ success: false, message: 'No pending charges' });
          const meta = typeof (row as any).meta === 'string' ? JSON.parse((row as any).meta || '{}') : (row as any).meta || {};
          const rowAmount = typeof (row as any).amount === 'number' ? (row as any).amount : 0;
          return jsonResponse({ success: true, chargeId: (row as any).ghl_charge_id, amount: rowAmount / 100, currency: (row as any).currency, checkout_url: meta.recurrente_checkout_url || null });
        }

        if (type === 'health' || type === 'ping' || type === 'capabilities') {
            return jsonResponse({ success: true, capabilities: ['payments', 'verify'], message: 'EPICPay1 provider is active' });
        }

        const tenant = await getTenant(env.DB, locationId);
        if (!tenant) return jsonResponse({ success: false, error: 'Tenant not found' }, 404);

        switch (type) {
          case 'ensure_checkout': return ensureCheckoutForLocation(request, env, tenant, body);
          case 'refund': return jsonResponse({ success: false, error: 'Refunds not yet implemented' }, 501);
          case 'subscription': return jsonResponse({ success: false, error: 'Subscriptions not yet implemented' }, 501);
          default: return jsonResponse({ success: false, error: `Unknown action type: ${type}` }, 400);
        }
    } catch (error) {
        console.error('[queryUrl] Error:', error);
        return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
}

async function ensureCheckoutForLocation(request: Request, env: Env, tenant: any, body: any): Promise<Response> {
    const locationId = body.locationId;
    if (!locationId) return jsonResponse({ success: false, error: 'Missing locationId' }, 400);

    const tokenRow = await getGhlToken(env.DB, locationId);
    if (!tokenRow || !tokenRow.access_token) return jsonResponse({ success: false, error: 'No GHL token' }, 404);
    const ghltoken = tokenRow.access_token;

    const invoiceId = body.invoiceId || body.chargeId || null;
    if (!invoiceId) return jsonResponse({ success: false, error: 'Missing invoiceId' }, 400);

    let invoice: any;
    try {
        const res = await fetch(`https://services.leadconnectorhq.com/payments/invoices/${invoiceId}?locationId=${locationId}`, {
            headers: { 'Authorization': `Bearer ${ghltoken}`, 'Version': '2021-07-28' }
        });
        if (!res.ok) throw new Error(`Failed: ${res.statusText}`);
        const data = await res.json() as any;
        invoice = data.invoice;
    } catch (e) { return jsonResponse({ success: false, error: (e as Error).message }, 500); }

    const item = invoice.invoiceItems?.[0] || null;
    const chargeId = invoice._id || invoice.invoiceNumber || `${invoice.altId}-${Date.now()}`;
    const amount = invoice.total || invoice.amountDue || (item ? item.amount : 0);
    const currency = invoice.currency || 'GTQ';
    const contactEmail = invoice.contactDetails?.email || '';
    const description = item ? item.name || invoice.name : invoice.name || 'Pago';

    if (!amount || amount <= 0) return jsonResponse({ success: false, error: 'Invalid amount' }, 422);
    const amountCents = Math.round(amount * 100);

    const existing = await env.DB.prepare('SELECT * FROM transactions WHERE ghl_charge_id = ? AND location_id = ? AND status = ? LIMIT 1').bind(chargeId, locationId, 'pending').first();
    if (existing) {
        const meta = typeof (existing as any).meta === 'string' ? JSON.parse((existing as any).meta || '{}') : (existing as any).meta || {};
        if ((existing as any).amount === amountCents && meta.recurrente_checkout_url) {
            return jsonResponse({ success: true, checkout_url: meta.recurrente_checkout_url, checkout_id: (existing as any).recurrente_checkout_id, chargeId, source: 'existing' });
        }
    }

    try {
        const checkout = await createCheckout(
            { publicKey: tenant.recurrente_public_key, secretKey: tenant.recurrente_secret_key },
            {
                amount_in_cents: amountCents, currency, product_name: description,
                success_url: `${new URL(request.url).origin}/payment/success?charge_id=${chargeId}`,
                cancel_url: `${new URL(request.url).origin}/payment/cancel?charge_id=${chargeId}`,
                email: contactEmail,
                metadata: { ghl_charge_id: chargeId, ghl_location_id: locationId }
            }
        );
        if (existing) { await updateTransactionByChargeId(env.DB, chargeId, 'pending', checkout.id); }
        else {
            await createTransaction(env.DB, {
                location_id: locationId, ghl_charge_id: chargeId, recurrente_checkout_id: checkout.id,
                amount: amountCents, currency, status: 'pending', meta: { recurrente_checkout_url: checkout.checkout_url }
            });
        }
        return jsonResponse({ success: true, checkout_url: checkout.checkout_url, checkout_id: checkout.id, chargeId, source: 'created' });
    } catch (err: any) { return jsonResponse({ success: false, error: err.message }, 500); }
}

export function safeDivideAmount(amount: any): number {
    return typeof amount === 'number' ? amount / 100 : 0;
}
