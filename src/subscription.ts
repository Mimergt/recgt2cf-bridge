/**
 * subscription.ts
 *
 * Handles subscription status verification and manual activation codes for the
 * Nexus Subscription Controller integration.
 *
 * Responsibilities:
 *  1. checkSubscriptionInWP()      — Query the WooCommerce REST endpoint to see if a
 *                                     GHL location_id has an active WC Subscription.
 *  2. checkManualActivation()      — Query D1 for a redeemed manual activation code for
 *                                     this location_id (gifted/comped accounts).
 *  3. isLocationActive()           — Combined check (WC OR manual).
 *  4. redeemCode()                 — Mark an activation code as used and associate it
 *                                     with a locationId.
 *  5. generateCode()               — Create a new activation code (admin only).
 *  6. listCodes()                  — List all codes (admin only).
 *  7. handleAppPage()              — Serve the /app HTML page (onboarding or keys screen).
 *  8. handleActivateCode()         — POST /app/activate-code endpoint.
 *  9. handleTenantStatus()         — POST /api/tenant-status (called by nexus-sc WP plugin).
 * 10. handleGenerateCode()         — POST /admin/generate-code (admin).
 * 11. handleListCodes()            — GET  /admin/codes (admin).
 */

import type { Env } from './types';
import { jsonResponse, htmlResponse } from './router';
import { getTenant } from './db';

// ─── Crypto helper ───────────────────────────────────────────

/**
 * Generate a URL-safe random code of the given byte length (default 16 → 22 base64url chars).
 */
function generateRandomCode(byteLength = 16): string {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    // Base64url encode
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

// ─── Auth helpers ───────────────────────────────────────────

function verifyNscAdminKey(request: Request, env: Env): boolean {
  const provided =
        request.headers.get('x-nsc-admin-key') ||
    request.headers.get('x-admin-key') ||
        new URL(request.url).searchParams.get('admin_key') ||
    new URL(request.url).searchParams.get('adminKey') ||
        '';

  const acceptedKeys = [env.NSC_ADMIN_KEY || '', env.ADMIN_SECRET || ''].filter(Boolean);
  if (acceptedKeys.length === 0 || !provided) return false;

  return acceptedKeys.some((key) => key === provided);
}

function verifyNscApiKey(request: Request, env: Env): boolean {
    const expected = env.WP_NEXUS_API_KEY || '';
    if (!expected) return false;
    const provided = request.headers.get('x-nsc-api-key') || '';
    return expected.length > 0 && provided.length > 0 && expected === provided;
}

// ─── 1. WooCommerce subscription check ──────────────────────

export interface WPSubscriptionStatus {
    active: boolean;
    status: string;
    subscription_id: number | null;
    error?: string;
}

/**
 * Call the nexus-sc REST endpoint on WordPress to check subscription status.
 * Returns { active: false } on any network/config error (fail-open is intentional
 * only if you want to be lenient; here we fail-closed for security).
 */
export async function checkSubscriptionInWP(
    locationId: string,
    env: Env
): Promise<WPSubscriptionStatus> {
    const wpUrl = env.WP_SITE_URL?.replace(/\/$/, '') ?? '';
    const apiKey = env.WP_NEXUS_API_KEY ?? '';

    if (!wpUrl || !apiKey) {
        return { active: false, status: 'not_configured', subscription_id: null, error: 'WP_SITE_URL or WP_NEXUS_API_KEY not set' };
    }

    try {
        const url = `${wpUrl}/wp-json/nexus-sc/v1/check-subscription?location_id=${encodeURIComponent(locationId)}&key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            // Cloudflare Workers fetch timeout is 30s by default
        });

        if (!res.ok) {
            return { active: false, status: `wp_error_${res.status}`, subscription_id: null };
        }

        const data = await res.json() as WPSubscriptionStatus;
        return data;
    } catch (err) {
        return {
            active: false,
            status: 'fetch_error',
            subscription_id: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

// ─── 2. Manual activation check (D1) ────────────────────────

export async function checkManualActivation(db: D1Database, locationId: string): Promise<boolean> {
    const row = await db
        .prepare('SELECT id FROM manual_activations WHERE location_id = ? AND is_used = 1 LIMIT 1')
        .bind(locationId)
        .first();
    return row !== null;
}

// ─── 3. Combined active check ────────────────────────────────

export async function isLocationActive(locationId: string, env: Env): Promise<{ active: boolean; source: string }> {
    // 1. Check manual activation first (fast, local D1 query)
    const manual = await checkManualActivation(env.DB, locationId);
    if (manual) return { active: true, source: 'manual_activation' };

    // 2. Check tenant.is_active in D1 (set by WP plugin sync)
    const tenant = await getTenant(env.DB, locationId);
    if (tenant && tenant.is_active === 1) {
        return { active: true, source: 'tenant_active' };
    }

    // 3. Live check against WooCommerce (authoritative)
    const wp = await checkSubscriptionInWP(locationId, env);
    if (wp.active) {
        // Opportunistically update is_active in D1 to speed up future checks
        if (tenant) {
            await env.DB
                .prepare("UPDATE tenants SET is_active = 1, updated_at = datetime('now') WHERE location_id = ?")
                .bind(locationId)
                .run();
        }
        return { active: true, source: 'wp_subscription' };
    }

    return { active: false, source: wp.error ? 'wp_error' : 'no_subscription' };
}

// ─── 4. Redeem activation code ───────────────────────────────

export async function redeemCode(
    db: D1Database,
    code: string,
    locationId: string
): Promise<{ success: boolean; error?: string }> {
    // Validate inputs
    if (!/^[a-zA-Z0-9_\-]{6,40}$/.test(code)) {
        return { success: false, error: 'Formato de código inválido.' };
    }
    if (!/^[a-zA-Z0-9_\-]{5,60}$/.test(locationId)) {
        return { success: false, error: 'locationId inválido.' };
    }

    // Check the code exists and is unused
    const row = await db
        .prepare('SELECT id, is_used FROM manual_activations WHERE code = ?')
        .bind(code)
        .first() as { id: number; is_used: number } | null;

    if (!row) {
        return { success: false, error: 'Código no encontrado.' };
    }
    if (row.is_used === 1) {
        return { success: false, error: 'Este código ya fue utilizado.' };
    }

    // Check this location doesn't already have a manual activation
    const existing = await db
        .prepare('SELECT id FROM manual_activations WHERE location_id = ? AND is_used = 1')
        .bind(locationId)
        .first();
    if (existing) {
        return { success: false, error: 'Esta cuenta ya tiene una activación manual.' };
    }

    // Redeem
    await db
        .prepare("UPDATE manual_activations SET is_used = 1, location_id = ?, used_at = datetime('now') WHERE id = ?")
        .bind(locationId, row.id)
        .run();

    return { success: true };
}

// ─── 5. Generate activation code (admin) ─────────────────────

export async function generateCode(
    db: D1Database,
    notes: string = ''
): Promise<{ code: string }> {
    const code = generateRandomCode(16);
    await db
        .prepare("INSERT INTO manual_activations (code, notes) VALUES (?, ?)")
        .bind(code, notes)
        .run();
    return { code };
}

// ─── 6. List codes (admin) ───────────────────────────────────

export async function listCodes(db: D1Database): Promise<unknown[]> {
    const { results } = await db
        .prepare('SELECT id, code, location_id, is_used, notes, created_at, used_at FROM manual_activations ORDER BY created_at DESC')
        .all();
    return results ?? [];
}

// ─── 7. /app page ────────────────────────────────────────────

/**
 * Serve the GHL Custom Page.
 *
 * - Reads locationId from localStorage (set during OAuth) or ?locationId= query param.
 * - Calls isLocationActive() → if true, shows the existing config/keys page.
 * - If false, shows the onboarding page (activate code OR buy subscription link).
 *
 * The WC store URL and subscription product ID can be set via env vars, but we
 * also build a JS-side redirect so the GHL app page looks seamless.
 */
export async function handleAppPage(request: Request, env: Env): Promise<Response> {
    const workerUrl = new URL(request.url).origin;
    const wpStoreUrl = (env.WP_SITE_URL ?? '').replace(/\/$/, '');

    // Server-side check if locationId is passed directly (e.g. for testing)
    const params = new URL(request.url).searchParams;
    const directLocationId = params.get('locationId') ?? '';

    let serverActive = false;
    if (directLocationId && /^[a-zA-Z0-9_\-]{5,60}$/.test(directLocationId)) {
        const result = await isLocationActive(directLocationId, env);
        serverActive = result.active;
    }

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus – EpicPay</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f2f5; color: #1c1e21; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .card {
      background: white; border-radius: 12px; padding: 2rem;
      box-shadow: 0 2px 12px rgba(0,0,0,.08); width: 100%; max-width: 480px;
    }
    .logo { color: #0080ff; font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
    .subtitle { color: #65676b; font-size: 0.85rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.1rem; margin-bottom: 1rem; }
    .section { margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; font-weight: 600; margin-bottom: 0.4rem; color: #444; }
    input[type=text] {
      width: 100%; padding: 0.65rem 0.8rem; border: 1px solid #ced4da;
      border-radius: 6px; font-size: 0.9rem; outline: none;
    }
    input[type=text]:focus { border-color: #0080ff; box-shadow: 0 0 0 2px rgba(0,128,255,.15); }
    .btn {
      display: inline-block; padding: 0.7rem 1.4rem; border-radius: 6px;
      font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none;
      text-decoration: none; text-align: center;
    }
    .btn-primary { background: #0080ff; color: white; width: 100%; margin-top: 0.5rem; }
    .btn-primary:hover { background: #0060cc; }
    .btn-secondary {
      background: white; color: #0080ff; border: 1.5px solid #0080ff;
      width: 100%; margin-top: 0.75rem;
    }
    .btn-secondary:hover { background: #f0f8ff; }
    .divider { border: none; border-top: 1px solid #e9ecef; margin: 1.5rem 0; }
    .msg { font-size: 0.82rem; margin-top: 0.5rem; min-height: 1.2rem; }
    .msg.error { color: #e03131; }
    .msg.success { color: #2d9448; }
    .spinner {
      width: 36px; height: 36px; border: 3px solid #e9ecef; border-top-color: #0080ff;
      border-radius: 50%; animation: spin .7s linear infinite; margin: 1rem auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #loading { text-align: center; }
    #onboarding, #keys-redirect { display: none; }
    #no-location { display: none; color: #e03131; text-align: center; font-size: 0.9rem; padding: 1rem 0; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ EpicPay</div>
  <div class="subtitle">Nexus Subscription Controller</div>

  <!-- Loading state -->
  <div id="loading">
    <div class="spinner"></div>
    <p style="color:#65676b; font-size:.85rem;">Verificando suscripción...</p>
  </div>

  <!-- No locationId found -->
  <div id="no-location">
    <p>⚠️ No se pudo identificar tu cuenta de GoHighLevel.<br>
    Asegúrate de abrir esta página desde la app instalada en tu sub-cuenta.</p>
  </div>

  <!-- Onboarding (no active subscription) -->
  <div id="onboarding">
    <h2>Activa tu integración</h2>

    <div class="section">
      <label for="code-input">Código de activación</label>
      <input type="text" id="code-input" placeholder="Ej: aB3dE-xYz12" autocomplete="off">
      <button class="btn btn-primary" onclick="activateCode()">Activar</button>
      <div id="code-msg" class="msg"></div>
    </div>

    <hr class="divider">

    <div class="section">
      <p style="font-size:.85rem; color:#555; margin-bottom:.75rem;">
        ¿No tienes un código? Adquiere tu suscripción para desbloquear la integración.
      </p>
      <a id="buy-link" href="#" class="btn btn-secondary" target="_top">
        → Comprar suscripción
      </a>
    </div>
  </div>

  <!-- Active: redirect to keys page -->
  <div id="keys-redirect">
    <div class="spinner"></div>
    <p style="color:#2d9448; font-size:.9rem; text-align:center; margin-top:.5rem;">
      ✅ Suscripción activa. Cargando configuración...
    </p>
  </div>
</div>

<script>
  const WORKER   = ${JSON.stringify(workerUrl)};
  const WP_STORE = ${JSON.stringify(wpStoreUrl)};
  // Server already checked if directLocationId was provided
  const SERVER_ACTIVE = ${JSON.stringify(serverActive)};
  const DIRECT_LOC    = ${JSON.stringify(directLocationId)};

  function show(id) {
    ['loading','no-location','onboarding','keys-redirect'].forEach(function(el) {
      document.getElementById(el).style.display = (el === id) ? 'block' : 'none';
    });
  }

  async function init() {
    var locationId = DIRECT_LOC || localStorage.getItem('ghl_location_id') || '';

    if (!locationId) {
      show('no-location');
      return;
    }

    // If server already resolved it (directLocationId path), use that
    if (DIRECT_LOC) {
      if (SERVER_ACTIVE) {
        activateKeys();
        return;
      }
      showOnboarding(locationId);
      return;
    }

    // Otherwise do a client-side async check
    try {
      var res = await fetch(WORKER + '/api/check-subscription?locationId=' + encodeURIComponent(locationId));
      var data = await res.json();
      if (data && data.active) {
        activateKeys();
      } else {
        showOnboarding(locationId);
      }
    } catch(e) {
      // On error, show onboarding (safe default)
      showOnboarding(locationId);
    }
  }

  function activateKeys() {
    show('keys-redirect');
    // Redirect to the existing config page (root /)
    setTimeout(function() {
      window.location.href = WORKER + '/';
    }, 1200);
  }

  function showOnboarding(locationId) {
    // Build the WC purchase link with ?account_id= so the plugin captures it
    var buyLink = document.getElementById('buy-link');
    if (WP_STORE) {
      buyLink.href = WP_STORE + '/checkout/?account_id=' + encodeURIComponent(locationId) + '&open-subscription=1';
    } else {
      buyLink.style.display = 'none';
    }
    window._locationId = locationId;
    show('onboarding');
  }

  async function activateCode() {
    var code = document.getElementById('code-input').value.trim();
    var msg  = document.getElementById('code-msg');
    var locationId = window._locationId || localStorage.getItem('ghl_location_id') || DIRECT_LOC;

    if (!code) { msg.className = 'msg error'; msg.textContent = 'Por favor ingresa un código.'; return; }
    if (!locationId) { msg.className = 'msg error'; msg.textContent = 'No se pudo determinar tu cuenta GHL.'; return; }

    msg.className = 'msg'; msg.textContent = 'Verificando...';

    try {
      var res = await fetch(WORKER + '/app/activate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, locationId: locationId })
      });
      var data = await res.json();
      if (data.success) {
        msg.className = 'msg success';
        msg.textContent = '✅ ¡Activado! Redirigiendo a configuración...';
        setTimeout(function() { activateKeys(); }, 1500);
      } else {
        msg.className = 'msg error';
        msg.textContent = data.error || 'Error al activar el código.';
      }
    } catch(e) {
      msg.className = 'msg error';
      msg.textContent = 'Error de conexión. Intenta de nuevo.';
    }
  }

  init();
</script>
</body>
</html>`;

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─── 8. POST /app/activate-code ─────────────────────────────

export async function handleActivateCode(request: Request, env: Env): Promise<Response> {
    try {
        const body = await request.json() as { code?: string; locationId?: string };
        const code       = (body.code ?? '').trim();
        const locationId = (body.locationId ?? '').trim();

        if (!code || !locationId) {
            return jsonResponse({ success: false, error: 'Faltan parámetros: code y locationId son requeridos.' }, 400);
        }

        const result = await redeemCode(env.DB, code, locationId);
        if (!result.success) {
            return jsonResponse({ success: false, error: result.error }, 400);
        }

        // Opportunistically update isActive in tenants table if tenant exists
        await env.DB
            .prepare("UPDATE tenants SET is_active = 1, updated_at = datetime('now') WHERE location_id = ?")
            .bind(locationId)
            .run();

        return jsonResponse({ success: true, message: 'Código activado correctamente.' });
    } catch (err) {
        return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
}

// ─── 9. POST /api/tenant-status (called by nexus-sc WP plugin) ──

export async function handleTenantStatus(request: Request, env: Env): Promise<Response> {
    if (!verifyNscApiKey(request, env)) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403);
    }

    try {
        const body = await request.json() as { locationId?: string; active?: boolean };
        const locationId = (body.locationId ?? '').trim();
        const active     = Boolean(body.active);

        if (!locationId || !/^[a-zA-Z0-9_\-]{5,60}$/.test(locationId)) {
            return jsonResponse({ success: false, error: 'locationId inválido o faltante.' }, 400);
        }

        // Update is_active on tenant if it exists
        const result = await env.DB
            .prepare("UPDATE tenants SET is_active = ?, updated_at = datetime('now') WHERE location_id = ?")
            .bind(active ? 1 : 0, locationId)
            .run();

        return jsonResponse({
            success: true,
            locationId,
            active,
            rows_updated: result.meta?.changes ?? 0,
        });
    } catch (err) {
        return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
}

// ─── 10. GET /api/check-subscription (client-side AJAX) ─────

export async function handleCheckSubscription(request: Request, env: Env): Promise<Response> {
    const params     = new URL(request.url).searchParams;
    const locationId = (params.get('locationId') ?? '').trim();

    if (!locationId || !/^[a-zA-Z0-9_\-]{5,60}$/.test(locationId)) {
        return jsonResponse({ success: false, active: false, error: 'locationId inválido.' }, 400);
    }

    const result = await isLocationActive(locationId, env);
    return jsonResponse({ success: true, ...result });
}

// ─── 11. POST /admin/generate-code ──────────────────────────────

export async function handleGenerateCode(request: Request, env: Env): Promise<Response> {
    if (!verifyNscAdminKey(request, env)) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403);
    }

    try {
        const body   = await request.json().catch(() => ({})) as { notes?: string; count?: number };
        const notes  = body.notes ?? '';
        const count  = Math.min(Math.max(1, Number(body.count) || 1), 50); // 1-50

        const codes: string[] = [];
        for (let i = 0; i < count; i++) {
            const { code } = await generateCode(env.DB, notes);
            codes.push(code);
        }

        return jsonResponse({ success: true, codes });
    } catch (err) {
        return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
}

// ─── 12. GET /admin/codes ────────────────────────────────────

export async function handleListCodes(request: Request, env: Env): Promise<Response> {
    if (!verifyNscAdminKey(request, env)) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403);
    }

    try {
        const codes = await listCodes(env.DB);
        return jsonResponse({ success: true, codes });
    } catch (err) {
        return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
}

// ─── 13. GET /admin/dashboard ───────────────────────────────

export async function handleAdminDashboard(request: Request, env: Env): Promise<Response> {
    if (!verifyNscAdminKey(request, env)) {
        return new Response(
            '<h1>403 Unauthorized</h1><p>Incluye adminKey o admin_key correcto en la URL.</p>',
            { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
    }

    const params = new URL(request.url).searchParams;
    const adminKey = params.get('adminKey') || params.get('admin_key') || '';

    const tenantsRes = await env.DB
        .prepare(`
            SELECT id, location_id, business_name, is_active, created_at, updated_at
            FROM tenants
            ORDER BY updated_at DESC
        `)
        .all();

    const tenants = (tenantsRes.results || []) as Array<{
        id: number;
        location_id: string;
        business_name: string;
        is_active: number;
        created_at: string;
        updated_at: string;
    }>;

    const rows = tenants.map((t) => `
      <tr>
        <td>${t.id}</td>
        <td><code>${t.location_id}</code></td>
        <td>${t.business_name || '-'}</td>
        <td>${t.is_active ? '<span class="ok">active</span>' : '<span class="off">inactive</span>'}</td>
        <td>${t.updated_at || '-'}</td>
      </tr>
    `).join('');

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EPICPay Admin Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; background: #f5f7fb; margin: 0; color: #1e2430; }
    .wrap { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
    .card { background: white; border: 1px solid #e8edf5; border-radius: 12px; box-shadow: 0 8px 24px rgba(18,28,45,.06); overflow: hidden; }
    .head { padding: 16px 20px; border-bottom: 1px solid #eef2f7; display:flex; justify-content:space-between; align-items:center; }
    h1 { margin: 0; font-size: 20px; }
    .meta { font-size: 13px; color: #627086; }
    .links a { margin-left: 10px; color: #0b63ce; text-decoration: none; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef2f7; }
    th { color: #546176; font-weight: 600; background: #fbfcfe; }
    code { font-size: 12px; background: #f2f6fc; padding: 2px 6px; border-radius: 6px; }
    .ok { color: #0f7b3e; font-weight: 600; }
    .off { color: #8a94a6; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div>
          <h1>Sub-cuentas configuradas</h1>
          <div class="meta">Total: ${tenants.length}</div>
        </div>
        <div class="links">
          <a href="/admin/tenants">JSON tenants</a>
          <a href="/admin/codes?admin_key=${encodeURIComponent(adminKey)}">Códigos</a>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Location ID</th>
            <th>Business</th>
            <th>Estado</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="5">No hay sub-cuentas configuradas.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
