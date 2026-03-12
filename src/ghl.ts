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
 * 6. Success page sends postMessage back to GHL with result
 */
export async function handlePaymentsUrl(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    // Return the HTML page that GHL will load in the iframe
    const workerUrl = new URL(request.url).origin;
    const refererHeader = request.headers.get('Referer') || '';
    const userAgent = request.headers.get('User-Agent') || '';

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
    #debug-box {
      display: none !important;
      max-height: 400px;
      overflow-y: auto;
      border: 2px solid #4263eb;
      background: #1a1a2e;
      color: #00ff88;
      padding: 12px;
      border-radius: 8px;
      margin-top: 16px;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    #debug-box.active { display: block !important; }
    #debug-box b { color: #00d4ff; }
    #manual-form {
      display: none;
      margin-top: 2rem;
      padding: 2rem;
      background: #f8f9fa;
      border-radius: 8px;
      max-width: 400px;
      margin-left: auto;
      margin-right: auto;
    }
    #manual-form.show { display: block; }
    #manual-form input {
      width: 100%;
      padding: 0.75rem;
      margin: 0.5rem 0;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
    }
    #manual-form button {
      width: 100%;
      padding: 0.75rem;
      margin-top: 1rem;
      background: #4263eb;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1rem;
    }
    #manual-form button:hover { background: #364dd9; }
    #manual-form label {
      display: block;
      margin-top: 1rem;
      font-weight: 600;
      color: #333;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h2 id="status-text">Preparando checkout...</h2>
    <p id="status-sub">Serás redirigido a la página de pago</p>
    <p class="error" id="error-msg"></p>
    
    <!-- Manual form fallback -->
    <form id="manual-form" onsubmit="return false;">
      <h3 style="text-align: center; margin-bottom: 1.5rem;">Completa los datos de pago</h3>
      <label>Número de Factura / Charge ID:</label>
      <input type="text" id="chargeId-input" placeholder="Ej: 123456" required>
      
      <label>Monto (GTQ):</label>
      <input type="number" id="amount-input" placeholder="Ej: 100.50" step="0.01" required>
      
      <label>Email:</label>
      <input type="email" id="email-input" placeholder="tu@email.com" required>
      
      <label>Nombre:</label>
      <input type="text" id="name-input" placeholder="Tu nombre" required>
      
      <button type="submit" id="submit-btn">Procesar Pago</button>
    </form>
    
    <pre id="debug-box"></pre>
  </div>

  <script>
    const WORKER_URL = '${workerUrl}';
    const HTTP_REFERER = '${refererHeader}';
    let messageLog = [];

    function showDebug(label, data) {
      const timestamp = new Date().toLocaleTimeString('es-ES');
      const box = document.getElementById('debug-box');
      if (box) {
        box.classList.add('active');
        const entry = '[' + timestamp + '] <b>' + label + ':</b><br>' + JSON.stringify(data, null, 2) + '<br>';
        box.innerHTML += entry;
        messageLog.push({ timestamp, label, data });
        box.scrollTop = box.scrollHeight;
      }
    }

    function extractInvoiceId(url) {
      if (!url) return null;
      // Patterns: /invoice/ID, /invoices/ID, or query param invoiceId=ID
      const m = url.match(/\/invoices?\/([a-fA-F0-9-]+)/) || url.match(/invoiceId=([a-fA-F0-9-]+)/);
      return m ? m[1] : null;
    }

    async function processPayment(data) {
      try {
        showDebug('🚀 processPayment called with', data);
        document.getElementById('status-text').textContent = 'Creando sesión de pago...';

        const chargeId = data.chargeId || data.charge_id || data.id;
        const amount = data.amount || data.total || data.balance;

        if (!chargeId) throw new Error('No chargeId found in data');
        if (!amount) throw new Error('No amount found in data');

        // Try to get locationId from multiple sources
        const locationId = data.locationId || data.location_id || data.locationID || 
                          localStorage.getItem('ghl_location_id') || 
                          sessionStorage.getItem('ghl_location_id') ||
                          null; // Removed default test location to prevent incorrect amounts

        const payload = {
          locationId: locationId,
          chargeId: chargeId,
          amount: amount,
          currency: data.currency || 'GTQ',
          contactName: data.contactName || data.name || data.contact_name || '',
          contactEmail: data.contactEmail || data.email || '',
          description: data.description || data.title || 'Pago GHL',
        };

        showDebug('📝 Prepared checkout payload', payload);

        const response = await fetch(WORKER_URL + '/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const result = await response.json();
        showDebug('✅ API Response', result);

        if (result.success && result.checkout_url) {
          showDebug('🎉 Checkout created, redirecting to Recurrente', { url: result.checkout_url });
          document.getElementById('status-text').textContent = 'Redirigiendo a pago...';
          setTimeout(() => {
            window.top.location.href = result.checkout_url;
          }, 500);
        } else {
          throw new Error(result.error || 'Error al crear sesión de pago');
        }
      } catch (err) {
        showDebug('❌ Error in processPayment', { message: err.message, stack: err.stack });
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('status-text').textContent = 'Error al procesar';
        document.getElementById('error-msg').style.display = 'block';
        document.getElementById('error-msg').textContent = err.message;
        const chargeId = data?.chargeId || data?.charge_id || data?.id;
        if (chargeId) {
          window.parent.postMessage({ chargeId: chargeId, status: 'failed', error: err.message }, '*');
        }
      }
    }

    // Initialize - wrap everything in async IIFE
    (async function init() {
      try {
        // Initial diagnostics
        showDebug('📍 Full URL', { 
          href: window.location.href, 
          search: window.location.search, 
          hash: window.location.hash,
          self: window.self === window.top ? 'TOP' : 'IN iframe'
        });
        showDebug('🌐 HTTP Headers (Server-side)', { 
          referer: HTTP_REFERER,
          userAgent: '${userAgent}'
        });
        showDebug('📍 Domain Info', {
          origin: window.location.origin,
          pathname: window.location.pathname
        });
        showDebug('📋 Referrer', { referrer: document.referrer, parent: window.parent ? 'has parent' : 'no parent' });
        showDebug('🔧 Window Info', { 
          timezoneOffset: new Date().getTimezoneOffset(),
          userAgent: navigator.userAgent,
          self: window.self === window.parent ? 'NOT in iframe' : 'IN iframe'
        });

        // 1. Check query params
        const urlParams = new URLSearchParams(window.location.search);
        const urlData = Object.fromEntries(urlParams.entries());
        showDebug('📌 URL Query Params', urlData);

        // 2. Check hash params (GHL may pass data as #chargeId=xxx)
        const hashParams = new URLSearchParams(window.location.hash.replace('#', ''));
        const hashData = Object.fromEntries(hashParams.entries());
        showDebug('🏷️ Hash Params', hashData);

        const merged = { ...urlData, ...hashData };
        
        // Try to extract invoiceId from referer or URL if not present
        if (!merged.chargeId) {
          const fromReferer = extractInvoiceId(HTTP_REFERER);
          const fromCurrent = extractInvoiceId(window.location.href);
          if (fromReferer || fromCurrent) {
             merged.chargeId = fromReferer || fromCurrent;
             showDebug('💡 Extracted chargeId from URL/Referer', { chargeId: merged.chargeId, source: fromReferer ? 'referer' : 'current' });
          }
        }

        if (merged.chargeId || merged.charge_id) {
          showDebug('✨ Found chargeId in URL/hash params', { chargeId: merged.chargeId || merged.charge_id });

          // If placeholders are present (GHL didn't substitute), avoid sending them to Recurrente
          const rawCharge = merged.chargeId || merged.charge_id || '';
          const rawAmount = merged.amount || '';
          const looksLikePlaceholder = (s) => typeof s === 'string' && s.includes('{');

          if (looksLikePlaceholder(rawCharge) || looksLikePlaceholder(rawAmount)) {
            showDebug('⚠️ Detected placeholder values in URL — will NOT call create-checkout with placeholders', { charge: rawCharge, amount: rawAmount });
            showDebug('📋 Full Referrer', { url: document.referrer });

            // Global listener for ANY message (for debugging and discovery)
            window.addEventListener('message', (event) => {
              try {
                let d = event.data;
                if (typeof d === 'string') { try { d = JSON.parse(d); } catch(ex){} }
                showDebug('📩 Message from ' + event.origin, { hasData: !!d, keys: d ? Object.keys(d).slice(0, 10) : [] });
                
                // If it looks like payment data, try to process it
                const pData = d?.data || d?.payload || d;
                const inv = pData?.invoice || (pData?.total || pData?.invoiceNumber ? pData : null);
                if (inv && inv.total && !window.__PROCESSED__) {
                  showDebug('📥 Caught invoice in postMessage!', { total: inv.total });
                  window.__PROCESSED__ = true;
                  // Map and process (omitted for brevity, will use the logic below)
                }
              } catch(e){}
            });

            // First, try to detect invoice data embedded in global objects (some GHL setups expose data synchronously)
             try {
               const tryGlobalInvoice = (() => {
                 const candidates = [];
                 try { if (window.__GHL__) candidates.push({ name: 'window.__GHL__', obj: window.__GHL__ }); } catch(e){ showDebug('❌ CORS: window.__GHL__', e.message); }
                 try { if (window.ghl) candidates.push({ name: 'window.ghl', obj: window.ghl }); } catch(e){ showDebug('❌ CORS: window.ghl', e.message); }
                 try { if (window.responseData) candidates.push({ name: 'window.responseData', obj: window.responseData }); } catch(e){ showDebug('❌ CORS: window.responseData', e.message); }
                 try { if (window.name) { try { candidates.push({ name: 'window.name', obj: JSON.parse(window.name) }); } catch(ex){ candidates.push({ name: 'window.name (raw)', obj: { name: window.name } }); } } } catch(e){}
                 try { if (window.opener && window.opener.responseData) candidates.push({ name: 'opener.responseData', obj: window.opener.responseData }); } catch(e){}
                 
                 try { if (window.parent && window.parent.__GHL__) candidates.push({ name: 'parent.__GHL__', obj: window.parent.__GHL__ }); } catch(e){ showDebug('❌ CORS: parent.__GHL__', e.message); }
                 try { if (window.parent && window.parent.ghl) candidates.push({ name: 'parent.ghl', obj: window.parent.ghl }); } catch(e){ showDebug('❌ CORS: parent.ghl', e.message); }
                 try { if (window.parent && window.parent.responseData) candidates.push({ name: 'parent.responseData', obj: window.parent.responseData }); } catch(e){ showDebug('❌ CORS: parent.responseData', e.message); }

                 showDebug('🔍 Checking candidates for global invoice', { found: candidates.length });
                 for (const cand of candidates) {
                   const c = cand.obj;
                   if (!c) continue;
                   showDebug('🔎 Inspecting candidate: ' + cand.name, { 
                     hasInvoice: !!c.invoice,
                     isInvoiceLike: !!(c.total || c.amountDue || c.invoiceNumber)
                   });
                   if (c.invoice) return c.invoice;
                   if (c.payload && c.payload.invoice) return c.payload.invoice;
                   if (c.data && c.data.invoice) return c.data.invoice;
                   if (c.total || c.amountDue || c.invoiceNumber) return c;
                 }
                 return null;
               })();

               if (tryGlobalInvoice) {
                 showDebug('📥 Found invoice in global object (sync)', { total: tryGlobalInvoice.total });
                 const inv = tryGlobalInvoice;
                 const item = Array.isArray(inv.invoiceItems) && inv.invoiceItems.length ? inv.invoiceItems[0] : null;
                 const mapped = {
                   chargeId: inv._id || inv.invoiceNumber || ((inv.altId || 'unknown') + '-' + Date.now()),
                   amount: inv.total || inv.invoiceTotal || inv.amountDue || (item ? item.amount : null),
                   currency: inv.currency || (item ? item.currency : null) || 'GTQ',
                   contactName: inv.contactDetails?.name || inv.contactDetails?.companyName || '',
                   contactEmail: inv.contactDetails?.email || '',
                   description: item ? item.name || item.description || inv.name || 'Pago GHL' : inv.name || 'Pago GHL',
                   locationId: inv.altId || (inv.layout && inv.layout.altId) || null
                 };
                 if (mapped.amount && Number(mapped.amount) > 0) {
                   processPayment(mapped);
                   return;
                 }
               }
             } catch (e) {
               showDebug('⚠️ Error while checking global invoice object', { error: e.message });
             }

            // Wait briefly for a postMessage or global invoice to arrive so we don't
            // prematurely redirect to a stale global pending checkout.
            const waitForLocalData = new Promise(async (resolve) => {
              let resolved = false;
              function onMsgOnce(event) {
                try {
                  let rawEvent = event.data;
                  if (typeof rawEvent === 'string') {
                    try { rawEvent = JSON.parse(rawEvent); } catch(e){}
                  }
                  const p = cloneData(rawEvent?.data || rawEvent?.payload || rawEvent);
                  // if invoice object present, map and create checkout
                  if (p && p.invoice) {
                    const inv = p.invoice;
                    const item = Array.isArray(inv.invoiceItems) && inv.invoiceItems.length ? inv.invoiceItems[0] : null;
                    const mapped = {
                      chargeId: inv._id || inv.invoiceNumber || ((inv.altId || 'unknown') + '-' + Date.now()),
                      amount: inv.total || inv.invoiceTotal || inv.amountDue || (item ? item.amount : null),
                      currency: inv.currency || (item ? item.currency : null) || 'GTQ',
                      contactName: inv.contactDetails?.name || inv.contactDetails?.companyName || '',
                      contactEmail: inv.contactDetails?.email || '',
                      description: item ? item.name || item.description || inv.name || 'Pago GHL' : inv.name || 'Pago GHL',
                      locationId: inv.altId || (inv.layout && inv.layout.altId) || null
                    };
                    if (mapped.amount && Number(mapped.amount) > 0) {
                      resolved = true;
                      window.removeEventListener('message', onMsgOnce);
                      processPayment(mapped);
                      resolve(true);
                      return;
                    }
                  }

                  // top-level chargeId present
                  const chargeIdTop = p?.chargeId || p?.charge_id || p?.id || p?._id;
                  if (chargeIdTop) {
                    resolved = true;
                    window.removeEventListener('message', onMsgOnce);
                    processPayment({ ...p, chargeId: chargeIdTop });
                    resolve(true);
                    return;
                  }
                } catch (e) {
                  // ignore
                }
              }
              window.addEventListener('message', onMsgOnce);
              // also short-circuit if parent/window has invoice immediately
              try {
                // Send a nudge to parent in case it's listening
                if (window.parent) {
                  showDebug('📡 Sending postMessage ping to parent...');
                  window.parent.postMessage({ type: 'REQUEST_INVOICE_DATA', source: 'recurrente-bridge' }, '*');
                }

                const tryGlobalInvoice2 = (() => {
                  const cands = [];
                  try { if (window.__GHL__) cands.push({ name: 'window.__GHL__', obj: window.__GHL__ }); } catch(e){}
                  try { if (window.ghl) cands.push({ name: 'window.ghl', obj: window.ghl }); } catch(e){}
                  try { if (window.responseData) cands.push({ name: 'window.responseData', obj: window.responseData }); } catch(e){}
                  try { if (window.name) { try { cands.push({ name: 'window.name', obj: JSON.parse(window.name) }); } catch(ex){} } } catch(e){}
                  
                  try { if (window.parent && window.parent.__GHL__) cands.push({ name: 'parent.__GHL__', obj: window.parent.__GHL__ }); } catch(e){}
                  try { if (window.parent && window.parent.ghl) cands.push({ name: 'parent.ghl', obj: window.parent.ghl }); } catch(e){}
                  try { if (window.parent && window.parent.responseData) cands.push({ name: 'parent.responseData', obj: window.parent.responseData }); } catch(e){}

                  showDebug('🔍 Checking candidates for global invoice (short-circuit)', { found: cands.length });
                  for (const cand of cands) {
                    const c = cand.obj;
                    if (!c) continue;
                    showDebug('🔎 Inspecting candidate (short-circuit): ' + cand.name, { 
                      hasInvoice: !!c.invoice,
                      isInvoiceLike: !!(c.total || c.amountDue || c.invoiceNumber)
                    });
                    if (c.invoice) return c.invoice;
                    if (c.payload && c.payload.invoice) return c.payload.invoice;
                    if (c.data && c.data.invoice) return c.data.invoice;
                    if (c.total || c.amountDue || c.invoiceNumber) return c;
                  }
                  return null;
                })();
                if (tryGlobalInvoice2) {
                  showDebug('📥 Found invoice in global object (short-circuit)', { total: tryGlobalInvoice2.total });
                  const inv2 = tryGlobalInvoice2;
                  const item = Array.isArray(inv2.invoiceItems) && inv2.invoiceItems.length ? inv2.invoiceItems[0] : null;
                  const mapped2 = {
                    chargeId: inv2._id || inv2.invoiceNumber || ((inv2.altId || 'unknown') + '-' + Date.now()),
                    amount: inv2.total || inv2.invoiceTotal || inv2.amountDue || (item ? item.amount : null),
                    currency: inv2.currency || (item ? item.currency : null) || 'GTQ',
                    contactName: inv2.contactDetails?.name || inv2.contactDetails?.companyName || '',
                    contactEmail: inv2.contactDetails?.email || '',
                    description: item ? item.name || item.description || inv2.name || 'Pago GHL' : inv2.name || 'Pago GHL',
                    locationId: inv2.altId || (inv2.layout && inv2.layout.altId) || null
                  };
                  if (mapped2.amount && Number(mapped2.amount) > 0) {
                    resolved = true;
                    processPayment(mapped2);
                    resolve(true);
                    return;
                  }
                }
              } catch (e) {}

              // timeout: proceed to server discovery if nothing arrives
              setTimeout(() => {
                if (!resolved) {
                  showDebug('⏱️ Timeout waiting for local/global data - falling back to server query');
                  try { window.removeEventListener('message', onMsgOnce); } catch(e){}
                  resolve(false);
                }
              }, 3000);
            });

            const possibleLocationId = 
              new URL(window.location.href).searchParams.get('locationId') ||
              sessionStorage.getItem('ghl_location_id') ||
              localStorage.getItem('ghl_location_id');

            if (possibleLocationId) {
              showDebug('📡 Found locationId via storage or params', { locationId: possibleLocationId });
              try {
                const qres = await fetch(WORKER_URL + '/api/query', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ type: 'get_pending_charge', locationId: possibleLocationId })
                });
                const jq = await qres.json();
                showDebug('🔎 Query result for location', jq);
                if (jq && jq.success && jq.checkout_url) {
                  showDebug('🎯 Redirecting to pre-created checkout', { url: jq.checkout_url });
                  window.top.location.href = jq.checkout_url;
                  return;
                }
                // If not found, try to force creation via ensure_checkout
                const ensureRes = await fetch(WORKER_URL + '/api/query', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ type: 'ensure_checkout', locationId: possibleLocationId })
                });
                const ensureJson = await ensureRes.json();
                showDebug('🔧 ensure_checkout result', ensureJson);
                if (ensureJson && ensureJson.success && ensureJson.checkout_url) {
                  window.top.location.href = ensureJson.checkout_url;
                  return;
                }
              } catch (e) {
                showDebug('❌ Error querying pending charge by location', { error: e.message });
              }
            }

/* 
            // Fallback: ask worker for any pending charge globally (debug / single-tenant friendly)
            // DISABLED: This causes cross-location data leakage in multi-tenant environments
            try {
              // First try global pre-created
              const globalRes = await fetch(WORKER_URL + '/api/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'get_pending_charge_global' })
              });
              const gq = await globalRes.json();
              showDebug('🌐 Global pending query result', gq);
              if (gq && gq.success && gq.checkout_url) {
                showDebug('➡️ Redirecting to global pre-created checkout', { url: gq.checkout_url });
                window.top.location.href = gq.checkout_url;
                return;
              }

              // If none found, attempt to force creation across all stored GHL tokens
              const ensureGlobal = await fetch(WORKER_URL + '/api/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ensure_checkout_global' })
              });
              const eg = await ensureGlobal.json();
              showDebug('🔧 ensure_checkout_global result', eg);
              if (eg && eg.success && eg.checkout_url) {
                window.top.location.href = eg.checkout_url;
                return;
              }
            } catch (e) {
              showDebug('❌ Error querying global pending charge', { error: e.message });
            }
*/

            // If nothing found, show manual form fallback
            showDebug('⚠️ No pre-created checkout found — showing manual form', {});
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status-text').textContent = 'Formulario de Pago Manual';
            document.getElementById('status-sub').textContent = 'GHL no está enviando los datos automáticamente. Por favor completa los datos de pago:';
            document.getElementById('manual-form').classList.add('show');
            return;
          }

          // Otherwise proceed with normal processing
          processPayment(merged);
        } else {
          showDebug('⏳ No chargeId in URL - waiting for postMessage...', {});
          document.getElementById('status-sub').textContent = 'Esperando datos de pago desde GHL...';

          let messageCount = 0;
          
          // Try to extract locationId from various sources
          const possibleLocationId = 
            new URL(window.location.href).searchParams.get('locationId') ||
            new URL(window.location.href).searchParams.get('location_id') ||
            sessionStorage.getItem('ghl_location_id') ||
            localStorage.getItem('ghl_location_id') ||
            window.__GHL__?.locationId ||
            window.ghl?.locationId;
          
          showDebug('🔍 Attempting to find locationId', { 
            found: !!possibleLocationId, 
            value: possibleLocationId,
            sessionStorage: sessionStorage.getItem('ghl_location_id'),
            localStorage: localStorage.getItem('ghl_location_id')
          });

          // Add message listener FIRST
          window.addEventListener('message', function(event) {
            messageCount++;
            showDebug('📬 postMessage event #' + messageCount, {
              origin: event.origin,
              type: typeof event.data,
              dataKeys: event.data ? (typeof event.data === 'object' ? Object.keys(event.data) : 'N/A') : 'null',
            });

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
