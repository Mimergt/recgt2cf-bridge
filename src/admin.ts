/**
 * Admin Handlers
 *
 * Endpoints for managing tenant configurations.
 * In production, these should be protected with authentication.
 */

import type { Env } from './types';
import { getTenant, upsertTenant, listTenants, deleteTenant, toggleTenant, listTenantsWithTokens, getValidGhlToken } from './db';
import { jsonResponse } from './router';

// ─── List Tenants ───────────────────────────────────────────

export async function handleListTenants(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const tenants = await listTenants(env.DB);
    // Mask secret keys in response
    const masked = tenants.map((t) => ({
        ...t,
        recurrente_secret_key: t.recurrente_secret_key.slice(0, 8) + '...',
        recurrente_public_key: t.recurrente_public_key.slice(0, 8) + '...',
    }));
    return jsonResponse({ success: true, tenants: masked });
}

// ─── Get Tenant ─────────────────────────────────────────────

export async function handleGetTenant(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const locationId = params.get('locationId');
    if (!locationId) {
        return jsonResponse({ success: false, error: 'Missing locationId parameter' }, 400);
    }

    const tenant = await getTenant(env.DB, locationId);
    if (!tenant) {
        return jsonResponse({ success: false, error: 'Tenant not found' }, 404);
    }

    const reveal = params.get('reveal') === '1';
    return jsonResponse({
        success: true,
        tenant: reveal ? tenant : {
            ...tenant,
            recurrente_secret_key: tenant.recurrente_secret_key ? tenant.recurrente_secret_key.slice(0, 8) + '...' : '',
            recurrente_public_key: tenant.recurrente_public_key ? tenant.recurrente_public_key.slice(0, 8) + '...' : '',
        },
    });
}

// ─── Create/Update Tenant ───────────────────────────────────

export async function handleUpsertTenant(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const body = await request.json<{
        locationId: string;
        publicKey?: string;
        secretKey?: string;
        publicKeyLive?: string;
        secretKeyLive?: string;
        mode?: 'test' | 'live';
        businessName?: string;
    }>();

    if (!body.locationId) {
        return jsonResponse(
            { success: false, error: 'Missing required field: locationId' },
            400
        );
    }

    await upsertTenant(env.DB, body.locationId, {
        publicKey: body.publicKey,
        secretKey: body.secretKey,
        publicKeyLive: body.publicKeyLive,
        secretKeyLive: body.secretKeyLive,
        mode: body.mode,
        businessName: body.businessName,
    });

    return jsonResponse({
        success: true,
        message: `Tenant ${body.locationId} configured successfully`,
    });
}

// ─── Delete Tenant ──────────────────────────────────────────

export async function handleDeleteTenant(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const body = await request.json<{ locationId: string }>();

    if (!body.locationId) {
        return jsonResponse({ success: false, error: 'Missing locationId' }, 400);
    }

    await deleteTenant(env.DB, body.locationId);

    return jsonResponse({
        success: true,
        message: `Tenant ${body.locationId} deleted`,
    });
}

// ─── Toggle Tenant Active Status ────────────────────────────

export async function handleToggleTenant(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const body = await request.json<{ locationId: string; active: boolean }>();

    if (!body.locationId || typeof body.active !== 'boolean') {
        return jsonResponse({ success: false, error: 'Missing locationId or active (boolean)' }, 400);
    }

    await toggleTenant(env.DB, body.locationId, body.active);

    return jsonResponse({
        success: true,
        message: `Sub-cuenta ${body.locationId} ${body.active ? 'autorizada' : 'desautorizada'}`,
    });
}

// ─── Admin Dashboard (HTML) ─────────────────────────────────

export async function handleAdminDashboard(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    const tenants = await listTenantsWithTokens(env.DB);

    // Auto-fetch names from GHL for tenants without business_name
    for (const t of tenants) {
        if (!t.business_name && t.has_token) {
            try {
                const token = await getValidGhlToken(env.DB, t.location_id, env.GHL_CLIENT_ID, env.GHL_CLIENT_SECRET);
                if (token) {
                    const res = await fetch(`https://services.leadconnectorhq.com/locations/${t.location_id}`, {
                        headers: { Authorization: `Bearer ${token.access_token}`, Version: '2021-07-28', Accept: 'application/json' },
                    });
                    if (res.ok) {
                        const data = await res.json() as any;
                        const locName = data.location?.name || data.name || '';
                        if (locName) {
                            t.business_name = locName;
                            await upsertTenant(env.DB, t.location_id, { businessName: locName });
                        }
                    }
                }
            } catch {}
        }
    }

    const rows = tenants.map(t => {
        const active = t.is_active === 1;
        const hasKeys = !!(t.recurrente_public_key && t.recurrente_secret_key);
        const mode = t.mode || 'test';
        const name = t.business_name || t.location_id;
        return `
        <tr class="${active ? '' : 'inactive'}">
            <td>
                <strong>${escapeHtml(name)}</strong>
                <br><small class="loc-id">${escapeHtml(t.location_id)}</small>
            </td>
            <td><span class="badge ${mode === 'live' ? 'live' : 'test'}">${mode.toUpperCase()}</span></td>
            <td><span class="badge ${hasKeys ? 'ok' : 'warn'}">${hasKeys ? 'Configuradas' : 'Sin llaves'}</span></td>
            <td><span class="badge ${t.has_token ? 'ok' : 'warn'}">${t.has_token ? 'Conectado' : 'Sin token'}</span></td>
            <td>
                <span class="badge ${active ? 'ok' : 'off'}">${active ? 'Autorizada' : 'Bloqueada'}</span>
            </td>
            <td>
                <button class="btn ${active ? 'btn-danger' : 'btn-success'}"
                    onclick="toggleTenant('${escapeHtml(t.location_id)}', ${!active})">
                    ${active ? 'Bloquear' : 'Autorizar'}
                </button>
            </td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EPICPay Admin - Sub-cuentas</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 0.9rem; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card { background: #1e293b; border-radius: 8px; padding: 16px 20px; flex: 1; min-width: 140px; }
    .stat-card .num { font-size: 1.8rem; font-weight: 700; color: #38bdf8; }
    .stat-card .label { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th { background: #334155; text-align: left; padding: 12px 16px; font-size: 0.8rem; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.05em; }
    td { padding: 12px 16px; border-top: 1px solid #334155; vertical-align: middle; }
    tr.inactive { opacity: 0.5; }
    .loc-id { color: #64748b; font-family: monospace; font-size: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge.ok { background: #166534; color: #4ade80; }
    .badge.warn { background: #713f12; color: #fbbf24; }
    .badge.off { background: #7f1d1d; color: #fca5a5; }
    .badge.test { background: #1e3a5f; color: #7dd3fc; }
    .badge.live { background: #166534; color: #4ade80; }
    .btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.8; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-success { background: #16a34a; color: white; }
    .btn-danger { background: #dc2626; color: white; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #1e293b; border: 1px solid #334155; padding: 12px 20px; border-radius: 8px; display: none; z-index: 99; }
    .toast.show { display: block; }
    @media (max-width: 640px) {
        table, thead, tbody, th, td, tr { display: block; }
        thead { display: none; }
        td { padding: 8px 16px; border: none; }
        td:first-child { padding-top: 16px; border-top: 1px solid #334155; }
        td:before { content: attr(data-label); display: block; font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; }
    }
</style>
</head>
<body>
<div class="container">
    <h1>EPICPay — Gestión de Sub-cuentas</h1>
    <p class="subtitle">Autoriza o bloquea sub-cuentas para usar el procesador de pagos</p>

    <div class="stats">
        <div class="stat-card">
            <div class="num">${tenants.length}</div>
            <div class="label">Total sub-cuentas</div>
        </div>
        <div class="stat-card">
            <div class="num">${tenants.filter((t: any) => t.is_active === 1).length}</div>
            <div class="label">Autorizadas</div>
        </div>
        <div class="stat-card">
            <div class="num">${tenants.filter((t: any) => t.is_active !== 1).length}</div>
            <div class="label">Bloqueadas</div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Sub-cuenta</th>
                <th>Modo</th>
                <th>Llaves Recurrente</th>
                <th>Token GHL</th>
                <th>Estado</th>
                <th>Acción</th>
            </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:40px;color:#94a3b8;">No hay sub-cuentas configuradas</td></tr>'}</tbody>
    </table>
</div>

<div id="toast" class="toast"></div>

<script>
const ADMIN_KEY = new URLSearchParams(location.search).get('adminKey') || '';

async function toggleTenant(locationId, active) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Procesando...';
    try {
        const res = await fetch('/admin/tenant/toggle?adminKey=' + encodeURIComponent(ADMIN_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locationId, active })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'ok');
            setTimeout(() => location.reload(), 600);
        } else {
            showToast('Error: ' + data.error, 'err');
            btn.disabled = false;
            btn.textContent = active ? 'Autorizar' : 'Bloquear';
        }
    } catch (e) {
        showToast('Error de red', 'err');
        btn.disabled = false;
        btn.textContent = active ? 'Autorizar' : 'Bloquear';
    }
}

function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.borderColor = type === 'ok' ? '#16a34a' : '#dc2626';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}
</script>
</body>
</html>`;

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
