/**
 * GHL Handlers
 *
 * These handle the two main integration points with GoHighLevel:
 *
 * 1. paymentsUrl  → loaded in an iframe by GHL checkout
 *    - Sends custom_provider_ready → receives payment_initiate_props from GHL
 *    - Creates a Recurrente checkout session
 *    - Opens Recurrente in a popup (iframe stays alive for GHL communication)
 *    - On success, sends custom_element_success_response to GHL
 *
 * 2. queryUrl → called server-to-server by GHL
 *    - Handles actions: verify, refund, subscription, etc.
 */

import type { Env, GHLQueryAction } from './types';
import { getTenant } from './db';
import { getValidGhlToken, getTransactionByCheckoutId, updateTransactionByCheckout } from './db';
import { createCheckout, getCheckoutStatus, toCents } from './recurrente';
import { createTransaction, getTransactionByChargeId, updateTransactionByChargeId, getActiveKeys, getSetting, getGhlPendingTransactions } from './db';
import { jsonResponse, htmlResponse } from './router';

// ─── paymentsUrl Handler ────────────────────────────────────

/**
 * This endpoint is loaded inside an iframe by GHL.
 * Follows the official GHL Custom Payment Provider protocol:
 * https://marketplace.gohighlevel.com/docs/marketplace-modules/Payments/index.html
 */
export async function handlePaymentsUrl(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
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
    .error { color: #e03131; display: none; margin-top: 1rem; font-size: 0.85rem; }
    #debug-box {
      max-height: 200px; overflow-y: auto; border: 1px solid #dee2e6;
      background: #f1f3f5; color: #495057; padding: 10px; border-radius: 6px;
      margin-top: 1.5rem; font-family: monospace; font-size: 10px;
      text-align: left; white-space: pre-wrap; word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h2 id="status-text">Preparando pago...</h2>
    <p id="status-sub">Conectando con GoHighLevel</p>
    <p class="error" id="error-msg"></p>
    <pre id="debug-box"></pre>
  </div>

  <script>
    var WORKER = ${JSON.stringify(workerUrl)};
    var ghlPaymentProps = null;
    var paymentStarted = false;

    function log(m, d) {
      var b = document.getElementById('debug-box');
      if (b) {
        b.textContent += '[' + new Date().toLocaleTimeString() + '] ' + m + (d ? ': ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '') + '\\n';
        b.scrollTop = b.scrollHeight;
      }
      console.log('[EPICPay]', m, d || '');
    }

    // ─── Step 1: Listen for GHL messages BEFORE sending ready ───
    window.addEventListener('message', function(e) {
      // Log EVERYTHING for debugging
      var raw = e.data;
      var origin = e.origin || 'unknown';
      
      if (!raw) return;
      
      var data = raw;
      
      // Try to parse if it's a string
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) {
          log('MSG IN (unparseable string)', { origin: origin, data: raw.substring ? raw.substring(0, 200) : raw });
          return;
        }
      }
      
      // Log ALL parsed messages with full details
      log('MSG IN', { origin: origin, type: data.type || '(no type)', keys: Object.keys(data).join(','), amount: data.amount, transactionId: data.transactionId });

      // ─── GHL sends payment_initiate_props with all payment details ───
      if (data.type === 'payment_initiate_props') {
        ghlPaymentProps = data;
        log('✅ payment_initiate_props received', {
          amount: data.amount,
          currency: data.currency,
          transactionId: data.transactionId,
          locationId: data.locationId,
          contact: data.contact ? data.contact.email : 'none'
        });
        startPayment(data);
        return;
      }

      // ─── GHL sends setup_initiate_props for card-on-file ───
      if (data.type === 'setup_initiate_props') {
        log('setup_initiate_props received (not supported)', data.type);
        // We don't support card-on-file yet
        sendToGhl({ type: 'custom_element_error_response', error: { description: 'Guardar tarjeta no soportado por EPICPay.' } });
        return;
      }

      // ─── Popup reports payment success ───
      if (data.type === 'RECURRENTE_SUCCESS') {
        log('✅ Popup reports payment success', data);
        handlePaymentComplete(data.chargeId, data.checkoutId);
        return;
      }
    });

    // ─── Step 2: Send custom_provider_ready to GHL (with retries) ───
    log('Full URL', location.href);
    log('URL params', Object.fromEntries(new URLSearchParams(location.search)));
    var readyRetries = 0;
    function sendReady() {
      readyRetries++;
      log('Sending custom_provider_ready (#' + readyRetries + ')');
      sendToGhl({ type: 'custom_provider_ready', loaded: true });
    }
    sendReady();
    // Retry every 2s up to 5 times in case GHL is slow (e.g. payment links)
    var readyInterval = setInterval(function() {
      if (ghlPaymentProps || paymentStarted || readyRetries >= 5) {
        clearInterval(readyInterval);
        return;
      }
      sendReady();
    }, 2000);

    // ─── Send postMessage to GHL parent ───
    function sendToGhl(msg) {
      var str = JSON.stringify(msg);
      log('MSG OUT', msg);
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(str, '*');
        }
        if (window.top && window.top !== window && window.top !== window.parent) {
          window.top.postMessage(str, '*');
        }
      } catch (err) {
        log('postMessage error', err.message);
      }
    }

    // ─── Helper: check if a URL param is a real value or a GHL placeholder ───
    function isReal(v) {
      return v && typeof v === 'string' && !v.includes('{') && v !== 'null' && v !== 'undefined' && v.length > 2;
    }

    // ─── Step 2b: Check if GHL sent real values via URL params ───
    var p = new URLSearchParams(location.search);
    var urlChargeId = p.get('chargeId') || '';
    var urlAmount = p.get('amount') || '';
    var urlCurrency = p.get('currency') || 'GTQ';
    var urlEmail = p.get('contactEmail') || '';
    var urlName = p.get('name') || '';
    var urlLocationId = p.get('locationId') || '';

    if (isReal(urlChargeId) && isReal(urlAmount) && parseFloat(urlAmount) > 0) {
      // GHL sent real values via URL → use them directly
      log('✅ Got real values from URL params', { chargeId: urlChargeId, amount: urlAmount, locationId: urlLocationId });
      startPayment({
        transactionId: urlChargeId,
        amount: parseFloat(urlAmount),
        currency: isReal(urlCurrency) ? urlCurrency : 'GTQ',
        contact: { email: isReal(urlEmail) ? urlEmail : '', name: isReal(urlName) ? urlName : '' },
        locationId: isReal(urlLocationId) ? urlLocationId : '',
        productDetails: null
      });
    } else if (isReal(urlChargeId)) {
      // We have a chargeId but no amount → resolve via API
      log('Got chargeId from URL but missing amount, resolving via API', urlChargeId);
      resolveAndPay(urlChargeId, isReal(urlLocationId) ? urlLocationId : '');
    } else {
      // GHL sent placeholders → wait for payment_initiate_props
      log('URL has placeholders, waiting for GHL payment_initiate_props...');
      // Also try auto-detect after 12s as last resort (give retries time)
      setTimeout(function() {
        if (!paymentStarted) {
          log('⚠️ No data from GHL after 12s, trying auto-detect (invoices + orders)');
          tryAutoDetectFallback();
        }
      }, 12000);
    }

    // ─── Step 3: Create Recurrente checkout and open popup ───
    function startPayment(props) {
      if (paymentStarted) return;
      paymentStarted = true;

      document.getElementById('status-text').textContent = 'Creando sesion de pago...';
      document.getElementById('status-sub').textContent = props.amount + ' ' + (props.currency || 'GTQ');

      var payload = {
        chargeId: props.transactionId || '',
        amount: props.amount,
        currency: props.currency || 'GTQ',
        contactEmail: props.contact ? props.contact.email : '',
        contactName: props.contact ? props.contact.name : '',
        locationId: props.locationId || '',
        description: props.productDetails ? props.productDetails.productId : 'Pago GHL'
      };

      log('Creating checkout', payload);

      fetch(WORKER + '/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success && d.checkout_url) {
          log('Checkout created', { url: d.checkout_url, checkoutId: d.checkout_id });
          openCheckoutPopup(d.checkout_url);
        } else {
          log('Checkout error', d.error);
          showError('Error al crear el pago: ' + (d.error || 'Desconocido'));
          sendToGhl({ type: 'custom_element_error_response', error: { description: d.error || 'Failed to create checkout' } });
        }
      })
      .catch(function(err) {
        log('Network error', err.message);
        showError('Error de conexion: ' + err.message);
        sendToGhl({ type: 'custom_element_error_response', error: { description: err.message } });
      });
    }

    // ─── Open Recurrente checkout in popup ───
    function openCheckoutPopup(url) {
      document.getElementById('status-text').textContent = 'Completa tu pago en la ventana emergente';
      document.getElementById('status-sub').textContent = 'Cuando el pago termine, GoHighLevel se actualizara automaticamente';

      var popup = window.open(url, 'recurrente_pay', 'width=820,height=720,left=180,top=80');
      if (popup && !popup.closed) {
        try { popup.focus(); } catch (_) {}
        log('Popup opened OK');
      } else {
        log('⚠️ Popup blocked (mobile), showing pay button');
        showPayButton(url);
      }
    }

    // ─── Mobile fallback: show a tap-to-pay button ───
    function showPayButton(url) {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('status-text').textContent = 'Listo para pagar';
      document.getElementById('status-sub').textContent = 'Toca el boton para abrir la pagina de pago';

      var container = document.querySelector('.container');
      var btn = document.createElement('a');
      btn.href = url;
      btn.target = '_blank';
      btn.textContent = 'Pagar ahora';
      btn.style.cssText = 'display:inline-block;margin-top:1.5rem;padding:1rem 2.5rem;background:#4263eb;color:white;border-radius:10px;font-size:1.15rem;font-weight:700;text-decoration:none;cursor:pointer;box-shadow:0 2px 8px rgba(66,99,235,0.3);';

      btn.addEventListener('click', function(e) {
        var w = window.open(url, '_blank');
        if (w) {
          e.preventDefault();
          log('Opened in new tab via user gesture');
          btn.textContent = 'Esperando pago...';
          btn.style.background = '#868e96';
          btn.style.boxShadow = 'none';
          btn.style.pointerEvents = 'none';
          startMobilePolling();
        } else {
          // Let native <a target=_blank> handle it
          log('window.open blocked, using native link navigation');
          startMobilePolling();
        }
      });

      container.appendChild(btn);
    }

    // ─── Poll for payment completion (mobile fallback) ───
    function startMobilePolling() {
      var pollChargeId = (ghlPaymentProps && ghlPaymentProps.transactionId) || urlChargeId || '';
      if (!pollChargeId) { log('No chargeId for polling'); return; }
      log('Starting mobile polling for chargeId=' + pollChargeId);
      var polls = 0;
      var pollInterval = setInterval(function() {
        polls++;
        if (polls > 60) { clearInterval(pollInterval); return; }
        fetch(WORKER + '/api/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ charge_id: pollChargeId })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.paid) {
            log('✅ Mobile poll detected payment complete');
            clearInterval(pollInterval);
            handlePaymentComplete(pollChargeId, '');
          }
        })
        .catch(function() {});
      }, 5000);
    }

    // ─── Step 4: Signal payment success to GHL ───
    function handlePaymentComplete(chargeId, checkoutId) {
      log('🎉 Payment complete! chargeId=' + chargeId + ' checkoutId=' + checkoutId);
      log('ghlPaymentProps was: ' + (ghlPaymentProps ? 'received (transactionId=' + ghlPaymentProps.transactionId + ')' : 'NEVER received'));
      
      document.getElementById('status-text').textContent = '¡Pago exitoso!';
      document.getElementById('status-sub').textContent = 'Notificando a GoHighLevel...';
      document.getElementById('spinner').style.display = 'none';

      // Use the GHL transactionId if we got payment_initiate_props, otherwise use chargeId
      var ghlChargeId = (ghlPaymentProps && ghlPaymentProps.transactionId) ? ghlPaymentProps.transactionId : (chargeId || '');
      
      log('Sending custom_element_success_response with chargeId=' + ghlChargeId);

      // Send multiple times to ensure GHL receives it
      function sendSuccess() {
        sendToGhl({
          type: 'custom_element_success_response',
          chargeId: ghlChargeId
        });
      }
      
      sendSuccess();
      // Retry a few times in case GHL missed it
      setTimeout(sendSuccess, 500);
      setTimeout(sendSuccess, 1500);
      setTimeout(sendSuccess, 3000);
      
      // After 5s, update status to show final state
      setTimeout(function() {
        document.getElementById('status-sub').textContent = 'Pago registrado. Si esta ventana no se cierra, puedes cerrarla.';
      }, 5000);
    }

    // ─── Auto-detect fallback (invoices + orders) ───
    function tryAutoDetectFallback() {
      log('Fallback: trying auto-detect via API (invoices + orders)');
      fetch(WORKER + '/api/debug-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: '{AUTO_DETECT}', locationId: isReal(urlLocationId) ? urlLocationId : '' })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.invoice) {
          var inv = data.invoice;
          var label = (data.source || '').indexOf('order') >= 0 ? 'order' : 'invoice';
          log('✅ Auto-detect found ' + label, '#' + (inv.invoiceNumber || inv.orderNumber || 'N/A') + ' - ' + (inv.amountDue || inv.total) + ' ' + (inv.currency || 'GTQ'));
          startPayment({
            transactionId: data.invoiceId,
            amount: inv.amountDue || inv.total,
            currency: inv.currency || 'GTQ',
            contact: inv.contactDetails ? { email: inv.contactDetails.email, name: inv.contactDetails.name } : {},
            locationId: data.locationId,
            productDetails: null
          });
        } else {
          showError('No se pudo detectar factura ni orden. ' + (data.error || ''));
        }
      })
      .catch(function(err) {
        showError('Error de conexion: ' + err.message);
      });
    }

    function resolveAndPay(chargeId, locationId) {
      log('Resolving invoice via API', chargeId);
      fetch(WORKER + '/api/debug-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: chargeId, locationId: locationId })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.invoice) {
          var inv = data.invoice;
          log('✅ Invoice resolved', '#' + inv.invoiceNumber + ' - ' + inv.total + ' ' + (inv.currency || 'GTQ'));
          startPayment({
            transactionId: data.invoiceId || chargeId,
            amount: inv.amountDue || inv.total,
            currency: inv.currency || 'GTQ',
            contact: inv.contactDetails ? { email: inv.contactDetails.email, name: inv.contactDetails.name } : {},
            locationId: data.locationId || locationId,
            productDetails: null
          });
        } else {
          showError('Factura no encontrada: ' + (data.error || ''));
        }
      })
      .catch(function(err) {
        showError('Error: ' + err.message);
      });
    }

    function showError(msg) {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('status-text').textContent = 'Error';
      var el = document.getElementById('error-msg');
      el.textContent = msg;
      el.style.display = 'block';
    }
  </script>
</body>
</html>`;

    return htmlResponse(html);
}

// ─── Payment Success Callback ───────────────────────────────

/** Build the HTML waiting page (queued state). Browser polls check_db every 10s. */
function buildWaitingPage(workerUrl: string, chargeId: string, checkoutId: string, invoiceUrl: string | null): string {
    const btnStyle = invoiceUrl ? 'display:inline-block' : 'display:none';
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pago recibido</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f8f9fa; color: #333;
    }
    .container { text-align: center; padding: 2rem; max-width: 420px; }
    .icon {
      width: 64px; height: 64px; border-radius: 50%; background: #1971c2;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem; animation: scaleIn 0.3s ease-out;
    }
    .icon svg { width: 32px; height: 32px; fill: white; }
    .check {
      width: 64px; height: 64px; border-radius: 50%; background: #2f9e44;
      display: none; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem; animation: scaleIn 0.3s ease-out;
    }
    .check svg { width: 32px; height: 32px; fill: white; }
    @keyframes scaleIn { from { transform: scale(0); } to { transform: scale(1); } }
    h2 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    .msg { color: #6c757d; font-size: 0.9rem; }
    .status { font-size: 0.82rem; margin-top: 0.75rem; color: #1971c2; }
    .btn {
      margin-top: 1.25rem; padding: 0.75rem 2rem;
      background: #1971c2; color: white; border-radius: 8px;
      font-size: 0.95rem; font-weight: 600; text-decoration: none;
      display: inline-block;
    }
    .hint { color: #adb5bd; font-size: 0.8rem; margin-top: 1rem; }
    .force-btn {
      display: none; margin-top: 1rem; padding: 0.6rem 1.5rem;
      background: white; color: #e03131; border: 1.5px solid #e03131;
      border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon" id="icon">
      <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
    </div>
    <div class="check" id="check">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h2 id="title">Pago recibido</h2>
    <p class="msg" id="msg">Tu pago fue recibido. Estamos sincronizando con el sistema, puede tardar unos minutos.</p>
    <p class="status" id="status">Actualizando factura...</p>
    <a class="btn" id="btn" href="${invoiceUrl || '#'}" style="${btnStyle}">Ver factura</a>
    <button class="force-btn" id="force-btn" onclick="forcePayment()">Reintentar registro manualmente</button>
    <p class="hint">Puedes cerrar esta pesta\u00f1a.</p>
  </div>
  <script>
    var WORKER = '${workerUrl}';
    var chargeId = '${chargeId}';
    var checkoutId = '${checkoutId}';
    var invoiceUrl = '${invoiceUrl || ''}';
    var pollCount = 0;
    var forceShown = false;
    function poll() {
      pollCount++;
      document.getElementById('status').textContent = 'Verificando... (' + pollCount + ')';
      fetch(WORKER + '/api/confirm-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ charge_id: chargeId, checkout_id: checkoutId, check_db: true })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.paid) {
          var url = data.invoiceUrl || invoiceUrl;
          document.getElementById('icon').style.display = 'none';
          document.getElementById('check').style.display = 'flex';
          document.getElementById('title').textContent = '\u00a1Pago exitoso!';
          document.getElementById('title').style.color = '#2f9e44';
          document.getElementById('msg').textContent = 'Tu pago ha sido procesado correctamente.';
          document.getElementById('status').textContent = 'Factura actualizada.';
          document.getElementById('status').style.color = '#2f9e44';
          document.getElementById('force-btn').style.display = 'none';
          if (url) {
            document.getElementById('btn').href = url;
            document.getElementById('btn').style.background = '#2f9e44';
            document.getElementById('btn').style.display = 'inline-block';
            // ✅ Wait 5 seconds before redirecting to give GHL time to verify payment via queryUrl
            setTimeout(function() { window.location.href = url; }, 5000);
          }
          return;
        }
        // Show manual button after ~45s (9 polls × 5s each)
        if (!forceShown && pollCount >= 9) {
          forceShown = true;
          document.getElementById('force-btn').style.display = 'inline-block';
          document.getElementById('msg').textContent = 'Tomando más tiempo del esperado. Presiona el botón para forzar el registro.';
        }
        setTimeout(poll, 5000);
      }).catch(function() {
        setTimeout(poll, 8000);
      });
    }
    function forcePayment() {
      var btn = document.getElementById('force-btn');
      btn.disabled = true;
      btn.textContent = 'Intentando...';
      document.getElementById('status').textContent = 'Forzando registro...';
      fetch(WORKER + '/api/force-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ charge_id: chargeId, checkout_id: checkoutId })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.paid) {
          var url = data.invoiceUrl || invoiceUrl;
          document.getElementById('status').textContent = '\u00a1Registrado!';
          if (url) setTimeout(function() { window.location.href = url; }, 1500);
        } else {
          btn.disabled = false;
          btn.textContent = 'Reintentar registro manualmente';
          var msg = data.error || 'Error. Intenta en 1 minuto.';
          // If 409 lock, be specific
          if (msg.includes('409') || msg.includes('lock')) {
            msg = 'Sistema ocupado (lock GHL). Espera ~1 minuto y vuelve a intentar.';
          }
          document.getElementById('status').textContent = msg;
        }
      }).catch(function() {
        btn.disabled = false;
        btn.textContent = 'Reintentar registro manualmente';
      });
    }
    // Start polling after 3s — gives the background task time to run
    setTimeout(poll, 3000);
  </script>
</body>
</html>`;
}

function buildPopupRelayPage(workerUrl: string, chargeId: string, checkoutId: string, invoiceUrl: string | null): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pago completado</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f8f9fa; }
    .container { text-align: center; padding: 2rem; }
    h2 { color: #2f9e44; margin-bottom: 0.5rem; }
    p { color: #6c757d; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Pago completado</h2>
    <p>Cerrando ventana...</p>
  </div>
  <script>
    var payload = {
      type: 'RECURRENTE_SUCCESS',
      chargeId: '${chargeId}',
      checkoutId: '${checkoutId}',
      invoiceUrl: '${invoiceUrl || ''}'
    };
    var hasOpener = window.opener && !window.opener.closed;
    var isInIframe = (window.parent && window.parent !== window);
    
    console.log('[PopupRelay] payload:', payload);
    console.log('[PopupRelay] window.opener:', hasOpener ? 'exists' : 'NULL');
    console.log('[PopupRelay] isInIframe:', isInIframe);
    
    function sendToOpener() {
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(payload, '*');
          console.log('[PopupRelay] Message sent to opener OK');
          return true;
        } catch (e) {
          console.log('[PopupRelay] postMessage to opener error:', e);
        }
      }
      return false;
    }
    
    // Send custom_element_success_response directly to GHL parent
    // (for mobile case where iframe redirected instead of opening popup)
    function sendDirectToGhl() {
      if (window.parent && window.parent !== window) {
        var msg = JSON.stringify({
          type: 'custom_element_success_response',
          chargeId: '${chargeId}'
        });
        try {
          window.parent.postMessage(msg, '*');
          if (window.top && window.top !== window.parent) {
            window.top.postMessage(msg, '*');
          }
          console.log('[PopupRelay] Sent custom_element_success_response to GHL parent');
          return true;
        } catch (e) {
          console.log('[PopupRelay] postMessage to parent error:', e);
        }
      }
      return false;
    }
    
    if (hasOpener) {
      // Normal popup flow: send RECURRENTE_SUCCESS to opener (our iframe JS)
      sendToOpener();
      setTimeout(sendToOpener, 300);
      setTimeout(sendToOpener, 800);
      setTimeout(sendToOpener, 1500);
      // Close popup after giving enough time
      setTimeout(function() {
        try { window.close(); } catch (e) {
          console.log('[PopupRelay] Could not close:', e);
          document.querySelector('p').textContent = 'Puedes cerrar esta ventana manualmente.';
        }
      }, 2000);
    } else if (isInIframe) {
      // Mobile redirect flow: we ARE in GHL's iframe, send directly to GHL
      console.log('[PopupRelay] No opener but in iframe — sending directly to GHL parent');
      sendDirectToGhl();
      setTimeout(sendDirectToGhl, 500);
      setTimeout(sendDirectToGhl, 1500);
      setTimeout(sendDirectToGhl, 3000);
      document.querySelector('h2').textContent = '¡Pago exitoso!';
      document.querySelector('p').textContent = 'Tu pago ha sido procesado.';
      // Redirect to invoice if available
      var invUrl = '${invoiceUrl || ''}';
      if (invUrl) {
        setTimeout(function() { window.location.href = invUrl; }, 4000);
      }
    } else {
      // Neither popup nor iframe — show success and redirect
      console.log('[PopupRelay] No opener, not in iframe — standalone page');
      document.querySelector('p').textContent = 'Pago completado. Puedes cerrar esta ventana.';
      var invUrl2 = '${invoiceUrl || ''}';
      if (invUrl2) {
        setTimeout(function() { window.location.href = invUrl2; }, 3000);
      }
    }
  </script>
</body>
</html>`;
}

/**
 * Background task: fetch invoice data and call record-payment with correct body.
 * Runs via ctx.waitUntil() so the browser gets the spinner HTML immediately.
 * Strategy:
 *   1. Fetch invoice → log full payments[] array (diagnostic)
 *   2. Try DELETE on any pending/in-progress payment (cancel GHL lock)
 *   3. POST record-payment with mode: "card"
 *   4. Updates D1 to 'completed' on success, 'ghl_pending' on failure (cron fallback).
 */
async function attemptRecordPaymentBackground(env: Env, invoiceId: string, locationId: string): Promise<void> {
    try {
        const tokenRow = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
        if (!tokenRow) {
            console.error('[Background] No GHL token for', locationId);
            await updateTransactionByChargeId(env.DB, invoiceId, 'ghl_pending');
            return;
        }
        const token = tokenRow.access_token;
        const authHeaders: Record<string, string> = {
            'Authorization': 'Bearer ' + token,
            'Version': '2021-07-28',
            'Accept': 'application/json'
        };

        // Fetch invoice — log full response for diagnosis
        const invRes = await fetch(
            'https://services.leadconnectorhq.com/invoices/' + invoiceId + '?altId=' + locationId + '&altType=location',
            { headers: authHeaders }
        );
        if (!invRes.ok) {
            console.error('[Background] Fetch invoice failed:', invoiceId, invRes.status, await invRes.text());
            await updateTransactionByChargeId(env.DB, invoiceId, 'ghl_pending');
            return;
        }
        const invData = await invRes.json() as any;

        // Log invoice status + payments array for diagnosis
        console.log('[Background] Invoice status:', invData.status, '| payments:', JSON.stringify(invData.payments || []));

        if (invData.status === 'paid') {
            console.log('[Background] Invoice already paid in GHL:', invoiceId);
            await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
            return;
        }

        const amount = invData.total ?? invData.amountDue ?? 0;
        const currency = invData.currency || 'GTQ';

        // Cancel any pending/in-progress payment records to release the GHL lock
        const payments: any[] = invData.payments || [];
        for (const p of payments) {
            const pid = p._id || p.id;
            const pstatus = (p.status || '').toLowerCase();
            if (pid && (pstatus === 'pending' || pstatus === 'in_progress' || pstatus === 'processing' || !pstatus)) {
                console.log('[Background] Attempting DELETE on pending payment:', pid, 'status:', pstatus);
                try {
                    const delRes = await fetch(
                        'https://services.leadconnectorhq.com/invoices/' + invoiceId + '/payments/' + pid,
                        { method: 'DELETE', headers: authHeaders }
                    );
                    console.log('[Background] DELETE payment response:', delRes.status, await delRes.text());
                } catch (e) {
                    console.error('[Background] DELETE payment error:', e);
                }
            }
        }

        // Call record-payment — mode = "card"
        const recBody = JSON.stringify({
            altId: locationId,
            altType: 'location',
            mode: 'card',
            amount,
            currency,
            notes: 'Pago via Recurrente (EPICPay)'
        });
        console.log('[Background] Calling record-payment:', invoiceId, recBody);
        const recRes = await fetch(
            'https://services.leadconnectorhq.com/invoices/' + invoiceId + '/record-payment',
            {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: recBody
            }
        );

        const recText = await recRes.text();
        console.log('[Background] record-payment response:', recRes.status, recText);

        if (recRes.ok) {
            console.log('[Background] record-payment success for', invoiceId);
            await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
            return;
        }

        if (recRes.status === 400 && recText.toLowerCase().includes('already paid')) {
            console.log('[Background] Invoice already paid (400):', invoiceId);
            await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
            return;
        }

        // 409 lock — try alternate path: POST /payments/transactions directly
        if (recRes.status === 409) {
            console.log('[Background] 409 lock — attempting /payments/transactions bypass');

            // First, check what GHL has in their transactions for this invoice
            try {
                const txListRes = await fetch(
                    'https://services.leadconnectorhq.com/payments/transactions?altId=' + locationId +
                    '&altType=location&entityId=' + invoiceId + '&entitySourceType=invoice',
                    { headers: authHeaders }
                );
                const txListText = await txListRes.text();
                console.log('[Background] GET /payments/transactions:', txListRes.status, txListText.slice(0, 500));
            } catch (e) {
                console.error('[Background] GET transactions error:', e);
            }

            // Try creating a transaction directly
            try {
                const newTxRes = await fetch(
                    'https://services.leadconnectorhq.com/payments/transactions',
                    {
                        method: 'POST',
                        headers: { ...authHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            altId: locationId,
                            altType: 'location',
                            amount,
                            currency,
                            entityId: invoiceId,
                            entitySourceType: 'invoice',
                            paymentProvider: 'EPICPay1',
                            status: 'success'
                        })
                    }
                );
                const newTxText = await newTxRes.text();
                console.log('[Background] POST /payments/transactions:', newTxRes.status, newTxText.slice(0, 500));
                if (newTxRes.ok) {
                    console.log('[Background] transactions bypass SUCCESS for', invoiceId);
                    await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
                    return;
                }
            } catch (e) {
                console.error('[Background] POST transactions error:', e);
            }
        }

        console.log('[Background] All attempts failed, queuing for cron:', invoiceId, recRes.status);
    } catch (e) {
        console.error('[Background] Unexpected error for', invoiceId, e);
    }

    // Failure → cron will retry
    await updateTransactionByChargeId(env.DB, invoiceId, 'ghl_pending');
}

/**
 * GET /payment/success
 * Returns spinner HTML immediately, then fires record-payment in background via ctx.waitUntil().
 * Browser polls /api/confirm-payment every 5s to detect completion.
 */
export async function handlePaymentSuccess(
    request: Request,
    env: Env,
    params: URLSearchParams,
    ctx?: ExecutionContext
): Promise<Response> {
    const checkoutId = params.get('checkout_id') || params.get('session_id') || '';
    const chargeId = params.get('charge_id') || '';
  const isPopupFlow = params.get('popup') === '1';
    const workerUrl = new URL(request.url).origin;

    // Find transaction
    let tx = checkoutId ? await getTransactionByCheckoutId(env.DB, checkoutId) : null;
    if (!tx && chargeId && !chargeId.includes('{')) {
        tx = await getTransactionByChargeId(env.DB, chargeId);
    }
    if (!tx) {
        console.error('[PaymentSuccess] Transaction not found charge=' + chargeId + ' checkout=' + checkoutId);
        return htmlResponse(buildWaitingPage(workerUrl, chargeId, checkoutId, null));
    }

    const locationId = tx.location_id;
    const invoiceId = tx.ghl_charge_id;
    if (!locationId || !invoiceId || invoiceId.includes('{')) {
        return htmlResponse(buildWaitingPage(workerUrl, chargeId, checkoutId, null));
    }

    // Compute invoice URL
    const invoiceDomain = await getSetting(env.DB, 'invoice_domain_' + locationId)
        || await getSetting(env.DB, 'invoice_domain');
    const invoiceUrl = invoiceDomain
        ? invoiceDomain.replace(/\/$/, '') + '/invoice/' + invoiceId
        : null;

    // ✅ Mark transaction as completed immediately (Recurrente redirect = payment complete)
    // GHL will verify via queryUrl and we'll respond { success: true }
    await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
    console.log('[PaymentSuccess] Marked tx as completed:', invoiceId);

    // Always run background record-payment as insurance
    // (on mobile, postMessage to GHL may fail, so this ensures the invoice gets marked paid)
    if (ctx) {
      if (isPopupFlow) {
        // Delay 12s for popup flow — give GHL time to process via custom_element_success_response first
        ctx.waitUntil((async () => {
          await new Promise(r => setTimeout(r, 12000));
          return attemptRecordPaymentBackground(env, invoiceId, locationId);
        })());
      } else {
        ctx.waitUntil(attemptRecordPaymentBackground(env, invoiceId, locationId));
      }
    }

    if (isPopupFlow) {
      // Return relay page that sends RECURRENTE_SUCCESS to opener (the GHL iframe)
      // or custom_element_success_response directly to GHL parent (mobile iframe redirect)
      return htmlResponse(buildPopupRelayPage(workerUrl, chargeId, checkoutId, invoiceUrl));
    }

    // Non-popup flow — redirect to invoice
    return invoiceUrl ? Response.redirect(invoiceUrl, 302) : htmlResponse(buildWaitingPage(workerUrl, chargeId, checkoutId, invoiceUrl));
}

/**
 * Browser polling endpoint — ONLY reads D1 status, no GHL API calls.
 * Record-payment is now handled server-side in handlePaymentSuccess.
 * Returns { paid, check_db, invoiceUrl }
 */
export async function handleConfirmPayment(
    request: Request,
    env: Env
): Promise<Response> {
    const body = await request.json() as any;
    const checkoutId = body.checkout_id || '';
    const chargeId = body.charge_id || '';

    if (!checkoutId && !chargeId) {
        return jsonResponse({ paid: false, error: 'Missing ids' }, 400);
    }

    let tx = checkoutId ? await getTransactionByCheckoutId(env.DB, checkoutId) : null;
    if (!tx && chargeId && !chargeId.includes('{')) {
        tx = await getTransactionByChargeId(env.DB, chargeId);
    }
    if (!tx) {
        return jsonResponse({ paid: false, check_db: true, invoiceUrl: null });
    }

    const locationId = tx.location_id;
    const invoiceId = tx.ghl_charge_id;
    const invoiceDomain = await getSetting(env.DB, 'invoice_domain_' + locationId)
        || await getSetting(env.DB, 'invoice_domain');
    const invoiceUrl = invoiceDomain && invoiceId
        ? invoiceDomain.replace(/\/$/, '') + '/invoice/' + invoiceId
        : null;

    if ((tx as any).status === 'completed') {
        return jsonResponse({ paid: true, invoiceUrl });
    }

    // Still pending — check GHL invoice status directly so we detect payment
    // without waiting for the 1-minute cron (browser polls every 5s)
    if (invoiceId && locationId) {
        const tokenRow = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
        if (tokenRow) {
            try {
                const invRes = await fetch(
                    'https://services.leadconnectorhq.com/invoices/' + invoiceId + '?altId=' + locationId + '&altType=location',
                    {
                        headers: {
                            'Authorization': 'Bearer ' + tokenRow.access_token,
                            'Version': '2021-07-28',
                            'Accept': 'application/json'
                        }
                    }
                );
                if (invRes.ok) {
                    const invData = await invRes.json() as any;
                    if (invData.status === 'paid') {
                        await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
                        return jsonResponse({ paid: true, invoiceUrl });
                    }
                }
            } catch (_) {
                // ignore — fall through to paid: false
            }
        }
    }

    return jsonResponse({ paid: false, check_db: true, invoiceUrl });
}

/**
 * POST /api/force-payment
 * Manual "force" endpoint — triggered by the waiting page button after ~45s.
 * Tries the full cancel-pending-then-record-payment flow and returns result.
 * Returns { paid: true, invoiceUrl } on success or { paid: false, error } on failure.
 */
export async function handleForcePayment(request: Request, env: Env): Promise<Response> {
    const body = await request.json() as any;
    const checkoutId = body.checkout_id || '';
    const chargeId = body.charge_id || '';

    let tx = checkoutId ? await getTransactionByCheckoutId(env.DB, checkoutId) : null;
    if (!tx && chargeId && !chargeId.includes('{')) {
        tx = await getTransactionByChargeId(env.DB, chargeId);
    }
    if (!tx) return jsonResponse({ paid: false, error: 'Transaction not found' }, 404);

    const locationId = tx.location_id;
    const invoiceId = tx.ghl_charge_id;
    if (!locationId || !invoiceId) return jsonResponse({ paid: false, error: 'Missing location or invoice' }, 400);

    const invoiceDomain = await getSetting(env.DB, 'invoice_domain_' + locationId)
        || await getSetting(env.DB, 'invoice_domain');
    const invoiceUrl = invoiceDomain ? invoiceDomain.replace(/\/$/, '') + '/invoice/' + invoiceId : null;

    if ((tx as any).status === 'completed') return jsonResponse({ paid: true, invoiceUrl });

    const tokenRow = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
    if (!tokenRow) return jsonResponse({ paid: false, error: 'No GHL token' }, 500);
    const token = tokenRow.access_token;
    const authHeaders: Record<string, string> = {
        'Authorization': 'Bearer ' + token,
        'Version': '2021-07-28',
        'Accept': 'application/json'
    };

    // Fetch invoice
    const invRes = await fetch(
        'https://services.leadconnectorhq.com/invoices/' + invoiceId + '?altId=' + locationId + '&altType=location',
        { headers: authHeaders }
    );
    if (!invRes.ok) return jsonResponse({ paid: false, error: 'Failed to fetch invoice: ' + invRes.status });
    const invData = await invRes.json() as any;
    console.log('[Force] Invoice status:', invData.status, '| payments:', JSON.stringify(invData.payments || []));

    if (invData.status === 'paid') {
        await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
        return jsonResponse({ paid: true, invoiceUrl });
    }

    const amount = invData.total ?? invData.amountDue ?? 0;
    const currency = invData.currency || 'GTQ';

    // Try to DELETE any pending payment records
    const payments: any[] = invData.payments || [];
    for (const p of payments) {
        const pid = p._id || p.id;
        const pstatus = (p.status || '').toLowerCase();
        if (pid && pstatus !== 'paid') {
            try {
                const delRes = await fetch(
                    'https://services.leadconnectorhq.com/invoices/' + invoiceId + '/payments/' + pid,
                    { method: 'DELETE', headers: authHeaders }
                );
                console.log('[Force] DELETE payment', pid, '→', delRes.status);
            } catch (_) {}
        }
    }

    // Call record-payment
    const recRes = await fetch(
        'https://services.leadconnectorhq.com/invoices/' + invoiceId + '/record-payment',
        {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ altId: locationId, altType: 'location', mode: 'card', amount, currency, notes: 'Pago via Recurrente (EPICPay) - forzado' })
        }
    );
    const recText = await recRes.text();
    console.log('[Force] record-payment:', recRes.status, recText);

    if (recRes.ok || (recRes.status === 400 && recText.toLowerCase().includes('already paid'))) {
        await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
        return jsonResponse({ paid: true, invoiceUrl });
    }

    // 409 — try POST /payments/transactions bypass
    if (recRes.status === 409) {
        try {
            const newTxRes = await fetch(
                'https://services.leadconnectorhq.com/payments/transactions',
                {
                    method: 'POST',
                    headers: { ...authHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        altId: locationId,
                        altType: 'location',
                        amount,
                        currency,
                        entityId: invoiceId,
                        entitySourceType: 'invoice',
                        paymentProvider: 'EPICPay1',
                        status: 'success'
                    })
                }
            );
            const newTxText = await newTxRes.text();
            console.log('[Force] POST /payments/transactions:', newTxRes.status, newTxText);
            if (newTxRes.ok) {
                await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
                return jsonResponse({ paid: true, invoiceUrl });
            }
            return jsonResponse({ paid: false, error: 'GHL 409 lock activo. Intenta de nuevo en ~5 minutos. Transactions API: ' + newTxRes.status + ' ' + newTxText, invoiceUrl });
        } catch (e) {
            return jsonResponse({ paid: false, error: 'GHL 409 lock activo y error en transactions: ' + String(e), invoiceUrl });
        }
    }

    return jsonResponse({ paid: false, error: 'GHL returned ' + recRes.status + ': ' + recText, invoiceUrl });
}

/**
 * Cron job: retry record-payment for all ghl_pending transactions.
 * Called by the Cloudflare scheduled handler every minute.
 */
export async function processGhlPendingPayments(env: Env): Promise<void> {
    const pending = await getGhlPendingTransactions(env.DB);
    if (pending.length === 0) return;
    console.log('[Cron] Processing', pending.length, 'pending GHL payments');

    for (const tx of pending) {
        const invoiceId = tx.ghl_charge_id;
        const locationId = tx.location_id;
        if (!invoiceId || !locationId) continue;

        const tokenRow = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
        if (!tokenRow) {
            console.error('[Cron] No GHL token for', locationId);
            continue;
        }

        const token = tokenRow.access_token;
        const authHeaders: Record<string, string> = {
            'Authorization': 'Bearer ' + token,
            'Version': '2021-07-28',
            'Accept': 'application/json'
        };

        try {
            // Fetch invoice for current status/amount/mode
            const invRes = await fetch(
                'https://services.leadconnectorhq.com/invoices/' + invoiceId + '?altId=' + locationId + '&altType=location',
                { headers: authHeaders }
            );
            if (!invRes.ok) {
                console.error('[Cron] Fetch invoice failed:', invoiceId, invRes.status);
                continue;
            }
            const invData = await invRes.json() as any;

            if (invData.status === 'paid') {
                console.log('[Cron] Invoice already paid:', invoiceId);
                await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
                continue;
            }

            const amount = invData.total || invData.amountDue || tx.amount;
            const currency = invData.currency || tx.currency || 'GTQ';

            const recordRes = await fetch(
                'https://services.leadconnectorhq.com/invoices/' + invoiceId + '/record-payment',
                {
                    method: 'POST',
                    headers: { ...authHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        altId: locationId,
                        altType: 'location',
                        mode: 'card',
                        amount,
                        currency,
                        notes: 'Pago via Recurrente (EPICPay) - reintento automático'
                    })
                }
            );

            if (recordRes.ok) {
                console.log('[Cron] record-payment success:', invoiceId);
                await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
            } else if (recordRes.status === 400) {
                const t = await recordRes.text();
                if (t.toLowerCase().includes('already paid')) {
                    console.log('[Cron] Invoice already paid (400):', invoiceId);
                    await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
                } else {
                    console.error('[Cron] record-payment 400:', invoiceId, t);
                }
            } else if (recordRes.status === 409) {
                console.log('[Cron] record-payment still 409 — trying transactions bypass:', invoiceId);
                try {
                    const newTxRes = await fetch(
                        'https://services.leadconnectorhq.com/payments/transactions',
                        {
                            method: 'POST',
                            headers: { ...authHeaders, 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                altId: locationId,
                                altType: 'location',
                                amount: invData.total || invData.amountDue || tx.amount,
                                currency: invData.currency || tx.currency || 'GTQ',
                                entityId: invoiceId,
                                entitySourceType: 'invoice',
                                paymentProvider: 'EPICPay1',
                                status: 'success'
                            })
                        }
                    );
                    const newTxText = await newTxRes.text();
                    console.log('[Cron] POST /payments/transactions:', newTxRes.status, newTxText.slice(0, 300));
                    if (newTxRes.ok) {
                        await updateTransactionByChargeId(env.DB, invoiceId, 'completed');
                    }
                } catch (e) {
                    console.error('[Cron] transactions bypass error:', e);
                }
            } else {
                const t = await recordRes.text();
                console.error('[Cron] record-payment error:', invoiceId, recordRes.status, t);
            }
        } catch (e) {
            console.error('[Cron] Error processing invoice:', invoiceId, e);
        }
    }
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

    const isPlaceholder = (v: any) => !v || (typeof v === 'string' && (v.includes('{') || v === 'null' || v === 'undefined'));
    
    // Clean placeholder values
    if (isPlaceholder(finalLocationId)) finalLocationId = '';
    if (isPlaceholder(finalAmount)) finalAmount = null;

    // If locationId is missing, try to find it from the chargeId across all locations (invoices + orders)
    if (!finalLocationId && body.chargeId && !isPlaceholder(body.chargeId)) {
        const allTokens = await env.DB.prepare('SELECT location_id, access_token FROM ghl_tokens ORDER BY updated_at DESC').all();
        for (const t of (allTokens.results || []) as any[]) {
            try {
                // Try invoice first
                const res = await fetch(`https://services.leadconnectorhq.com/invoices/${body.chargeId}?altId=${t.location_id}&altType=location`, {
                    headers: { 'Authorization': `Bearer ${t.access_token}`, 'Version': '2021-07-28', 'Accept': 'application/json' }
                });
                if (res.ok) {
                    const data = await res.json() as any;
                    const inv = data.invoice || data;
                    if (inv && (inv.total || inv.amountDue)) {
                        finalLocationId = t.location_id;
                        finalAmount = inv.amountDue || inv.total;
                        finalContactEmail = finalContactEmail || inv.contactDetails?.email;
                        finalContactName = finalContactName || inv.contactDetails?.name;
                        finalDescription = inv.invoiceItems?.[0]?.name || inv.name || 'Pago GHL';
                        break;
                    }
                }
                // Try order if invoice not found
                const orderRes = await fetch(`https://services.leadconnectorhq.com/payments/orders/${body.chargeId}?altId=${t.location_id}&altType=location`, {
                    headers: { 'Authorization': `Bearer ${t.access_token}`, 'Version': '2021-07-28', 'Accept': 'application/json' }
                });
                if (orderRes.ok) {
                    const orderData = await orderRes.json() as any;
                    if (orderData && orderData.amount) {
                        finalLocationId = t.location_id;
                        finalAmount = orderData.amount;
                        finalContactEmail = finalContactEmail || orderData.contactSnapshot?.email;
                        finalContactName = finalContactName || orderData.contactSnapshot?.fullName || orderData.contactSnapshot?.name;
                        finalDescription = (orderData.source && orderData.source.name) || orderData.name || 'Payment Link';
                        break;
                    }
                }
            } catch (e) { /* try next */ }
        }
    }

    if (!finalLocationId || !body.chargeId || !finalAmount || isPlaceholder(finalAmount)) {
        // Still missing? Try to resolve with known locationId
        if (finalLocationId && (isPlaceholder(finalAmount) || !finalAmount)) {
            try {
                const ghlTokenRow = await getValidGhlToken(env.DB, finalLocationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
                if (ghlTokenRow) {
                    const gToken = ghlTokenRow.access_token;
                    const headers = { 'Authorization': `Bearer ${gToken}`, 'Version': '2021-07-28', 'Accept': 'application/json' };
                    
                    let inv: any = null;
                    const invResp = await fetch(`https://services.leadconnectorhq.com/invoices/${body.chargeId}?altId=${finalLocationId}&altType=location`, { headers });
                    if (invResp.ok) {
                        const invData = await invResp.json() as any;
                        inv = invData.invoice || invData;
                    }
                    if (!inv) {
                        const gResp = await fetch(`https://services.leadconnectorhq.com/payments/invoices/${body.chargeId}?locationId=${finalLocationId}`, { headers });
                        if (gResp.ok) {
                            const gData = await gResp.json() as any;
                            inv = gData.invoice;
                        }
                    }
                    // Try order API as fallback
                    if (!inv) {
                        const orderResp = await fetch(`https://services.leadconnectorhq.com/payments/orders/${body.chargeId}?altId=${finalLocationId}&altType=location`, { headers });
                        if (orderResp.ok) {
                            const orderData = await orderResp.json() as any;
                            if (orderData && orderData.amount) {
                                inv = {
                                    total: orderData.amount,
                                    amountDue: orderData.amount,
                                    currency: orderData.currency || 'GTQ',
                                    contactDetails: {
                                        name: orderData.contactSnapshot?.fullName || orderData.contactSnapshot?.name || 'Customer',
                                        email: orderData.contactSnapshot?.email || ''
                                    },
                                    name: (orderData.source && orderData.source.name) || orderData.name || 'Payment Link'
                                };
                            }
                        }
                    }
                    if (inv) {
                        finalAmount = inv.amountDue || inv.total;
                        finalContactEmail = finalContactEmail || inv.contactDetails?.email;
                        finalContactName = finalContactName || inv.contactDetails?.name || inv.contactDetails?.companyName;
                        if (!finalDescription || isPlaceholder(finalDescription)) {
                            const item = inv.invoiceItems?.[0];
                            finalDescription = item?.name || item?.description || inv.name || 'Pago GHL';
                        }
                    }
                }
            } catch (e) {
                console.error('Failed to resolve GHL invoice server-side:', e);
            }
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
    const tenant = await getTenant(env.DB, finalLocationId);
    if (!tenant) {
        return jsonResponse(
            { success: false, error: `No Recurrente configuration found for location: ${finalLocationId}` },
            404
        );
    }

    // Resolve product name from invoice/order if still default
    if (!finalDescription || finalDescription === 'Pago GHL' || isPlaceholder(finalDescription)) {
        try {
            const ghlTokenRow = await getValidGhlToken(env.DB, finalLocationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
            if (ghlTokenRow) {
                const h = { 'Authorization': `Bearer ${ghlTokenRow.access_token}`, 'Version': '2021-07-28', 'Accept': 'application/json' };
                // Try invoice
                const invResp = await fetch(`https://services.leadconnectorhq.com/invoices/${body.chargeId}?altId=${finalLocationId}&altType=location`, { headers: h });
                if (invResp.ok) {
                    const invData = await invResp.json() as any;
                    const inv = invData.invoice || invData;
                    if (inv) {
                        const item = inv.invoiceItems?.[0];
                        finalDescription = item?.name || item?.description || inv.name || finalDescription;
                    }
                }
                // Try order if still default
                if (!finalDescription || finalDescription === 'Pago GHL') {
                    const orderResp = await fetch(`https://services.leadconnectorhq.com/payments/orders/${body.chargeId}?altId=${finalLocationId}&altType=location`, { headers: h });
                    if (orderResp.ok) {
                        const orderData = await orderResp.json() as any;
                        if (orderData) {
                            finalDescription = (orderData.source?.name) || orderData.name || finalDescription;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[createCheckout] Failed to resolve product name:', e);
        }
        // Prefix with business name
        const bizName = tenant.business_name;
        if (bizName && finalDescription && !finalDescription.startsWith(bizName)) {
            finalDescription = bizName + ' - ' + finalDescription;
        } else if (bizName && (!finalDescription || finalDescription === 'Pago GHL')) {
            finalDescription = 'Pago - ' + bizName;
        }
    }

    // 2. Build success/cancel URLs
    const workerUrl = new URL(request.url).origin;
    // NOTE: checkout_id gets appended after createCheckout below
    const baseSuccessUrl = `${workerUrl}/payment/success?charge_id=${body.chargeId}&popup=1`;
    const cancelUrl = `${workerUrl}/payment/cancel?charge_id=${body.chargeId}`;

    // 3. Create Recurrente checkout
    const checkout = await createCheckout(
        getActiveKeys(tenant),
        {
            amount_in_cents: toCents(finalAmount),
            currency: body.currency || 'GTQ',
            product_name: finalDescription || 'Pago GHL',
            success_url: baseSuccessUrl,
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

        if (type === 'resolve_location') {
          const cid = (body as any).chargeId;
          const tokens = await env.DB.prepare('SELECT location_id, access_token FROM ghl_tokens').all();
          const rows = tokens.results || [];
          
          // Try to find the invoice across all authorized locations
          const results = await Promise.all(rows.map(async (t: any) => {
            try {
              const res = await fetch(`https://services.leadconnectorhq.com/payments/invoices/${cid}?locationId=${t.location_id}`, {
                headers: { 'Authorization': `Bearer ${t.access_token}`, 'Version': '2021-07-28' }
              });
              if (res.ok) return t.location_id;
            } catch(e) {}
            return null;
          }));
          
          const found = results.find(r => r !== null);
          return jsonResponse({ success: !!found, locationId: found });
        }

        if (type === 'debug_invoice') {
          let invId = (body as any).invoiceId;
          let locId = (body as any).locationId || locationId || '';
          
          // Detect placeholder strings from GHL
          const isPlaceholderStr = (v: string) => !v || v.includes('{') || v === 'null' || v === 'undefined';
          if (isPlaceholderStr(locId)) locId = '';
          if (invId && isPlaceholderStr(invId)) invId = '';

          // Gather all available tokens
          const allTokens = await env.DB.prepare('SELECT location_id, access_token FROM ghl_tokens ORDER BY updated_at DESC').all();
          const tokenList = (allTokens.results || []) as { location_id: string; access_token: string }[];
          
          if (tokenList.length === 0) return jsonResponse({ success: false, error: 'No GHL tokens available. Install the app first.' });

          // Helper: try invoice API with a specific token
          const tryInvoice = async (token: string, lId: string, id: string) => {
            const url = `https://services.leadconnectorhq.com/invoices/${id}?altId=${lId}&altType=location`;
            const res = await fetch(url, {
              headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28' }
            });
            if (res.ok) {
              const data = await res.json() as any;
              const inv = data.invoice || data;
              return {
                invoiceNumber: inv.invoiceNumber || 'INV',
                name: inv.name || 'GHL Invoice',
                total: inv.total,
                amountDue: inv.amountDue || inv.total,
                currency: inv.currency || 'GTQ',
                contactDetails: inv.contactDetails || {}
              };
            }
            return null;
          };

          const tryOrder = async (token: string, lId: string, id: string) => {
            const url = `https://services.leadconnectorhq.com/payments/orders/${id}?altId=${lId}&altType=location`;
            const res = await fetch(url, {
              headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28' }
            });
            if (res.ok) {
              const data = await res.json() as any;
              return {
                invoiceNumber: data.orderNumber || 'ORD',
                name: (data.source && data.source.name) || 'GHL Order',
                total: data.amount,
                amountDue: data.amount,
                currency: data.currency || 'GTQ',
                contactDetails: {
                  name: data.contactSnapshot ? data.contactSnapshot.fullName : 'Customer',
                  email: data.contactSnapshot ? data.contactSnapshot.email : ''
                }
              };
            }
            return null;
          };

          // Build list of locations to try
          const locationsToTry: { locId: string; token: string }[] = [];
          if (locId) {
            const match = tokenList.find(t => t.location_id === locId);
            if (match) locationsToTry.push({ locId: match.location_id, token: match.access_token });
          }
          // Always add all others as fallback
          for (const t of tokenList) {
            if (!locationsToTry.some(l => l.locId === t.location_id)) {
              locationsToTry.push({ locId: t.location_id, token: t.access_token });
            }
          }

          // If we have a specific invoice ID, try to find it across locations
          if (invId) {
            for (const loc of locationsToTry) {
              const invoice = await tryInvoice(loc.token, loc.locId, invId) || await tryOrder(loc.token, loc.locId, invId);
              if (invoice) {
                return jsonResponse({ success: true, invoice, invoiceId: invId, source: 'debug', locationId: loc.locId });
              }
            }
          }

          // AUTO-DETECT: No invoice ID — find the most recent pending invoice across all locations
          for (const loc of locationsToTry) {
            try {
              const listUrl = `https://services.leadconnectorhq.com/invoices/?altId=${loc.locId}&altType=location&limit=5&offset=0`;
              const listRes = await fetch(listUrl, {
                headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${loc.token}`, 'Version': '2021-07-28' }
              });
              if (listRes.ok) {
                const listData = await listRes.json() as any;
                const best = (listData.invoices || []).find((i: any) => i.status === 'sent' || i.amountDue > 0);
                if (best) {
                  const invoice = await tryInvoice(loc.token, loc.locId, best._id);
                  if (invoice) {
                    return jsonResponse({ success: true, invoice, invoiceId: best._id, source: 'auto_detect_invoice', locationId: loc.locId });
                  }
                }
              }
            } catch (e) {
              console.error('Error listing invoices for', loc.locId, e);
            }
          }

          // AUTO-DETECT ORDERS: search for recent pending/unfulfilled orders (payment links)
          console.log('[debug_invoice] No pending invoices found, searching orders...');
          for (const loc of locationsToTry) {
            try {
              const ordersUrl = `https://services.leadconnectorhq.com/payments/orders?altId=${loc.locId}&altType=location&limit=5`;
              const ordersRes = await fetch(ordersUrl, {
                headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${loc.token}`, 'Version': '2021-07-28' }
              });
              if (ordersRes.ok) {
                const ordersData = await ordersRes.json() as any;
                const orders = ordersData.data || ordersData.orders || [];
                console.log('[debug_invoice] Orders for', loc.locId, ':', orders.length, 'found');
                // Find first order that needs payment (not completed/paid)
                const pending = orders.find((o: any) => {
                  const status = (o.status || '').toLowerCase();
                  const fulfillment = (o.fulfillmentStatus || '').toLowerCase();
                  return status !== 'completed' && status !== 'paid' && status !== 'refunded' && fulfillment !== 'fulfilled';
                });
                if (pending) {
                  console.log('[debug_invoice] Found pending order:', pending._id, 'amount:', pending.amount);
                  const orderInvoice = {
                    invoiceNumber: pending.orderNumber || pending.name || 'ORD',
                    orderNumber: pending.orderNumber || pending.name || 'ORD',
                    name: (pending.source && pending.source.name) || pending.name || 'Payment Link Order',
                    total: pending.amount || 0,
                    amountDue: pending.amount || 0,
                    currency: pending.currency || 'GTQ',
                    contactDetails: {
                      name: pending.contactSnapshot ? (pending.contactSnapshot.fullName || pending.contactSnapshot.name || 'Customer') : 'Customer',
                      email: pending.contactSnapshot ? (pending.contactSnapshot.email || '') : ''
                    }
                  };
                  return jsonResponse({ success: true, invoice: orderInvoice, invoiceId: pending._id, source: 'auto_detect_order', locationId: loc.locId });
                }
              } else {
                console.log('[debug_invoice] Orders API error for', loc.locId, ':', ordersRes.status);
              }
            } catch (e) {
              console.error('Error listing orders for', loc.locId, e);
            }
          }

          return jsonResponse({ success: false, error: 'No pending invoices or orders found across all connected accounts' });
        }

        if (type === 'list_all_invoices') {
          const tokens = await env.DB.prepare('SELECT location_id, access_token FROM ghl_tokens').all();
          const rows = tokens.results || [];
          const accounts: any[] = [];
          
          for (const t of rows) {
            try {
              const res = await fetch(`https://services.leadconnectorhq.com/payments/invoices?locationId=${t.location_id}&limit=20`, {
                headers: { 'Authorization': `Bearer ${t.access_token}`, 'Version': '2021-07-28' }
              });
              if (res.ok) {
                const data = await res.json() as any;
                accounts.push({
                  locationId: t.location_id,
                  invoices: (data.invoices || []).map((inv: any) => ({
                    id: inv._id,
                    number: inv.invoiceNumber,
                    total: inv.total,
                    status: inv.status
                  }))
                });
              } else {
                accounts.push({ locationId: t.location_id, error: `GHL Error ${res.status}` });
              }
            } catch(e) {
              accounts.push({ locationId: t.location_id, error: (e as Error).message });
            }
          }
          return jsonResponse({ success: true, accounts });
        }

        if (type === 'health' || type === 'ping' || type === 'capabilities') {
            return jsonResponse({ success: true, capabilities: ['payments', 'verify'], message: 'EPICPay1 provider is active' });
        }

        // GHL calls verify to check if a specific charge was paid
        // Docs: respond with { success: true } for paid, { success: false } for pending, { failed: true } for failure
        if (type === 'verify' || type === 'payment_status' || type === 'check_payment') {
            const chargeId = (body as any).chargeId || (body as any).charge_id || '';
            const transactionId = (body as any).transactionId || '';
            console.log('[queryUrl] VERIFY action chargeId:', chargeId, 'transactionId:', transactionId, 'locationId:', locationId);
            
            // Check D1 by chargeId (which is the GHL invoice ID we used)
            if (chargeId) {
                const tx = await getTransactionByChargeId(env.DB, chargeId);
                if (tx && (tx as any).status === 'completed') {
                    console.log('[queryUrl] VERIFY → success (D1 completed)');
                    return jsonResponse({ success: true });
                }
            }

            // Check GHL invoice directly as fallback
            const lookupId = chargeId || transactionId;
            if (lookupId && locationId) {
                const tokenRow = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
                if (tokenRow) {
                    try {
                        const invRes = await fetch(
                            'https://services.leadconnectorhq.com/invoices/' + lookupId + '?altId=' + locationId + '&altType=location',
                            { headers: { 'Authorization': 'Bearer ' + tokenRow.access_token, 'Version': '2021-07-28', 'Accept': 'application/json' } }
                        );
                        if (invRes.ok) {
                            const inv = await invRes.json() as any;
                            if (inv.status === 'paid') {
                                await updateTransactionByChargeId(env.DB, lookupId, 'completed');
                                console.log('[queryUrl] VERIFY → success (GHL invoice paid)');
                                return jsonResponse({ success: true });
                            }
                        }
                    } catch (_) {}
                }
            }

            console.log('[queryUrl] VERIFY → pending');
            return jsonResponse({ success: false });
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

    const tokenRow = await getValidGhlToken(env.DB, locationId, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
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
            getActiveKeys(tenant),
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
