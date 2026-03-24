/**
 * Admin Handlers
 *
 * Endpoints for managing tenant configurations.
 * In production, these should be protected with authentication.
 */

import type { Env } from './types';
import { getTenant, upsertTenant, listTenants, deleteTenant, toggleTenant, listTenantsWithTokens, getValidGhlToken } from './db';
import { jsonResponse } from './router';

type WooSubscriptionInfo = {
    active: boolean;
    subscriptionId: string;
    expiresAt: string;
};

type GroupSource = 'woo' | 'gift';

type TenantGroup = {
    id: number;
    name: string;
    source_type: GroupSource;
    color: string;
};

async function ensureManualActivationsTable(db: D1Database): Promise<void> {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS manual_activations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            location_id TEXT,
            is_used INTEGER DEFAULT 0,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            used_at TEXT
        )`
    ).run();
}

async function ensureTenantGroupsTables(db: D1Database): Promise<void> {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS tenant_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source_type TEXT NOT NULL CHECK (source_type IN ('woo', 'gift')),
            color TEXT DEFAULT '#2563eb',
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(name, source_type)
        )`
    ).run();

    await db.prepare(
        `CREATE TABLE IF NOT EXISTS tenant_group_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id TEXT NOT NULL,
            source_type TEXT NOT NULL CHECK (source_type IN ('woo', 'gift')),
            group_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(location_id, source_type),
            FOREIGN KEY (group_id) REFERENCES tenant_groups(id) ON DELETE CASCADE
        )`
    ).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_tenant_groups_source ON tenant_groups(source_type)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_tenant_group_assignments_location_source ON tenant_group_assignments(location_id, source_type)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_tenant_group_assignments_group ON tenant_group_assignments(group_id)').run();
}

function normalizeSourceType(sourceType: string): GroupSource | null {
    if (sourceType === 'woo' || sourceType === 'gift') return sourceType;
    return null;
}

async function resolveTenantAccessSource(env: Env, locationId: string): Promise<'woo' | 'gift' | 'none'> {
    const woo = await fetchWooSubscriptionInfo(env, locationId);
    if (woo.active) return 'woo';

    const gift = await env.DB.prepare(
        'SELECT id FROM manual_activations WHERE is_used = 1 AND location_id = ? LIMIT 1'
    ).bind(locationId).first<{ id: number }>();
    if (gift) return 'gift';
    return 'none';
}

function makeRandomCode(size = 11): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = 'EPIC-GT';
    for (let i = 0; i < size; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

async function fetchWooSubscriptionInfo(env: Env, locationId: string): Promise<WooSubscriptionInfo> {
    const wpSite = (env.WP_SITE_URL || '').replace(/\/+$/, '');
    const wpKey = env.WP_NEXUS_API_KEY || '';
    if (!wpSite || !wpKey) {
        return { active: false, subscriptionId: '', expiresAt: '' };
    }

    try {
        const url = new URL('/wp-json/nexus-sc/v1/check-subscription', wpSite);
        url.searchParams.set('location_id', locationId);
        url.searchParams.set('key', wpKey);
        const res = await fetch(url.toString(), { method: 'GET' });
        if (!res.ok) return { active: false, subscriptionId: '', expiresAt: '' };

        const data = await res.json() as any;
        const active = !!(data?.active || data?.is_active || data?.has_active_subscription);
        const subscriptionId = String(
            data?.subscription_id || data?.subscriptionId || data?.id || data?.wc_subscription_id || ''
        );
        const expiresAt = String(
            data?.expires_at || data?.expiry_date || data?.next_payment_date || data?.renewal_date || ''
        );
        return { active, subscriptionId, expiresAt };
    } catch {
        return { active: false, subscriptionId: '', expiresAt: '' };
    }
}

// ─── Gift Codes Admin ──────────────────────────────────────

export async function handleListGiftCodes(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureManualActivationsTable(env.DB);
    const { results } = await env.DB.prepare(
        'SELECT id, code, location_id, is_used, notes, created_at, used_at FROM manual_activations ORDER BY created_at DESC LIMIT 200'
    ).all();
    return jsonResponse({ success: true, codes: results || [] });
}

export async function handleCreateGiftCode(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureManualActivationsTable(env.DB);
    const body = await request.json<{ code?: string; notes?: string }>();
    const code = (body.code || makeRandomCode()).trim().toUpperCase();
    const notes = (body.notes || '').trim();
    if (!code) return jsonResponse({ success: false, error: 'Código vacío' }, 400);

    try {
        await env.DB.prepare(
            'INSERT INTO manual_activations (code, notes, is_used, created_at) VALUES (?, ?, 0, datetime(\'now\'))'
        ).bind(code, notes).run();
        return jsonResponse({ success: true, code, message: 'Código creado' });
    } catch (err) {
        return jsonResponse({ success: false, error: 'Código ya existe o no se pudo crear' }, 400);
    }
}

export async function handleRedeemGiftCode(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureManualActivationsTable(env.DB);
    const body = await request.json<{ locationId?: string; code?: string }>();
    const locationId = (body.locationId || '').trim();
    const code = (body.code || '').trim().toUpperCase();
    if (!locationId || !code) return jsonResponse({ success: false, error: 'Faltan locationId o code' }, 400);

    const woo = await fetchWooSubscriptionInfo(env, locationId);
    if (woo.active) {
        return jsonResponse({ success: false, error: 'Sub-cuenta con Woo activa no puede usar códigos regalo' }, 400);
    }

    const row = await env.DB.prepare('SELECT id, is_used, location_id FROM manual_activations WHERE code = ? LIMIT 1')
        .bind(code)
        .first<{ id: number; is_used: number; location_id: string | null }>();

    if (!row) return jsonResponse({ success: false, error: 'Código no existe' }, 404);
    if (row.is_used === 1 && row.location_id && row.location_id !== locationId) {
        return jsonResponse({ success: false, error: 'Código ya usado por otra sub-cuenta' }, 400);
    }

    await env.DB.prepare(
        'UPDATE manual_activations SET is_used = 1, location_id = ?, used_at = datetime(\'now\') WHERE id = ?'
    ).bind(locationId, row.id).run();

    await upsertTenant(env.DB, locationId, {});
    await toggleTenant(env.DB, locationId, true);
    return jsonResponse({ success: true, message: `Código aplicado a ${locationId}` });
}

export async function handleListTenantGroups(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureTenantGroupsTables(env.DB);
    const sourceType = normalizeSourceType((params.get('sourceType') || '').trim());

    if (sourceType) {
        const { results } = await env.DB.prepare(
            'SELECT id, name, source_type, color FROM tenant_groups WHERE source_type = ? ORDER BY name ASC'
        ).bind(sourceType).all<TenantGroup>();
        return jsonResponse({ success: true, groups: results || [] });
    }

    const { results } = await env.DB.prepare(
        'SELECT id, name, source_type, color FROM tenant_groups ORDER BY source_type ASC, name ASC'
    ).all<TenantGroup>();
    return jsonResponse({ success: true, groups: results || [] });
}

export async function handleCreateTenantGroup(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureTenantGroupsTables(env.DB);
    const body = await request.json<{ name?: string; sourceType?: string; color?: string }>();
    const name = (body.name || '').trim();
    const sourceType = normalizeSourceType((body.sourceType || '').trim());
    const color = (body.color || '').trim() || (sourceType === 'gift' ? '#6d28d9' : '#1e3a8a');

    if (!name) return jsonResponse({ success: false, error: 'Nombre de grupo requerido' }, 400);
    if (!sourceType) return jsonResponse({ success: false, error: 'sourceType debe ser woo o gift' }, 400);

    try {
        await env.DB.prepare(
            'INSERT INTO tenant_groups (name, source_type, color, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
        ).bind(name, sourceType, color).run();
        return jsonResponse({ success: true, message: 'Grupo creado', group: { name, sourceType, color } });
    } catch {
        return jsonResponse({ success: false, error: 'Grupo ya existe o no se pudo crear' }, 400);
    }
}

export async function handleAssignTenantGroup(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureTenantGroupsTables(env.DB);
    await ensureManualActivationsTable(env.DB);

    const body = await request.json<{ locationId?: string; sourceType?: string; groupId?: number | null }>();
    const locationId = (body.locationId || '').trim();
    const sourceType = normalizeSourceType((body.sourceType || '').trim());
    const groupId = body.groupId == null ? null : Number(body.groupId);

    if (!locationId) return jsonResponse({ success: false, error: 'locationId requerido' }, 400);
    if (!sourceType) return jsonResponse({ success: false, error: 'sourceType inválido' }, 400);
    if (groupId !== null && (!Number.isFinite(groupId) || groupId <= 0)) {
        return jsonResponse({ success: false, error: 'groupId inválido' }, 400);
    }

    const currentSource = await resolveTenantAccessSource(env, locationId);
    if (currentSource !== sourceType) {
        return jsonResponse({
            success: false,
            error: `No se puede asignar grupo ${sourceType.toUpperCase()} a sub-cuenta de origen ${currentSource.toUpperCase()}`
        }, 400);
    }

    if (groupId === null) {
        await env.DB.prepare('DELETE FROM tenant_group_assignments WHERE location_id = ? AND source_type = ?')
            .bind(locationId, sourceType)
            .run();
        return jsonResponse({ success: true, message: `Grupo removido de ${locationId}` });
    }

    const group = await env.DB.prepare('SELECT id, source_type FROM tenant_groups WHERE id = ? LIMIT 1')
        .bind(groupId)
        .first<{ id: number; source_type: GroupSource }>();
    if (!group) return jsonResponse({ success: false, error: 'Grupo no existe' }, 404);
    if (group.source_type !== sourceType) {
        return jsonResponse({ success: false, error: 'El grupo no pertenece al mismo origen' }, 400);
    }

    await env.DB.prepare(
        `INSERT INTO tenant_group_assignments (location_id, source_type, group_id, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(location_id, source_type) DO UPDATE SET
            group_id = excluded.group_id,
            updated_at = datetime('now')`
    ).bind(locationId, sourceType, groupId).run();

    return jsonResponse({ success: true, message: `Grupo asignado a ${locationId}` });
}

export async function handleDeleteGiftCode(
    request: Request,
    env: Env,
    params: URLSearchParams
): Promise<Response> {
    await ensureManualActivationsTable(env.DB);
    const body = await request.json<{ id?: number }>();
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
        return jsonResponse({ success: false, error: 'Falta id válido del código' }, 400);
    }

    const existing = await env.DB.prepare('SELECT id, code FROM manual_activations WHERE id = ? LIMIT 1')
        .bind(id)
        .first<{ id: number; code: string }>();
    if (!existing) {
        return jsonResponse({ success: false, error: 'Código no existe' }, 404);
    }

    await env.DB.prepare('DELETE FROM manual_activations WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true, message: `Código ${existing.code} eliminado` });
}

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
    await ensureManualActivationsTable(env.DB);
    await ensureTenantGroupsTables(env.DB);

    const dashboardParams = new URL(request.url).searchParams;
    const wooGroupFilter = (dashboardParams.get('wooGroup') || 'all').trim();
    const giftGroupFilter = (dashboardParams.get('giftGroup') || 'all').trim();

    const tenants = await listTenantsWithTokens(env.DB);

    const { results: codeRows } = await env.DB.prepare(
        'SELECT id, code, location_id, is_used, notes, created_at, used_at FROM manual_activations ORDER BY created_at DESC LIMIT 200'
    ).all<any>();
    const giftCodeRows = codeRows || [];

    const { results: groupRows } = await env.DB.prepare(
        'SELECT id, name, source_type, color FROM tenant_groups ORDER BY source_type ASC, name ASC'
    ).all<TenantGroup>();
    const allGroups = groupRows || [];

    const { results: assignmentRows } = await env.DB.prepare(
        'SELECT location_id, source_type, group_id FROM tenant_group_assignments'
    ).all<{ location_id: string; source_type: GroupSource; group_id: number }>();

    const groupsById = new Map<number, TenantGroup>();
    const groupsBySource: Record<GroupSource, TenantGroup[]> = { woo: [], gift: [] };
    for (const g of allGroups) {
        groupsById.set(g.id, g);
        groupsBySource[g.source_type].push(g);
    }

    const assignmentByKey = new Map<string, number>();
    for (const a of assignmentRows || []) {
        assignmentByKey.set(`${a.location_id}:${a.source_type}`, a.group_id);
    }

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

    const enriched = await Promise.all(tenants.map(async (t: any) => {
        const woo = await fetchWooSubscriptionInfo(env, t.location_id);
        const giftCode = giftCodeRows.find((c: any) => c.is_used === 1 && c.location_id === t.location_id);
        const accessSource: 'woo' | 'gift' | 'none' = woo.active ? 'woo' : (giftCode ? 'gift' : 'none');
        const conflict = !!(woo.active && giftCode);
        const sourceForGroup: GroupSource | null = accessSource === 'none' ? null : accessSource;
        const assignedGroupId = sourceForGroup ? assignmentByKey.get(`${t.location_id}:${sourceForGroup}`) || null : null;
        const assignedGroup = assignedGroupId ? groupsById.get(assignedGroupId) || null : null;

        return {
            ...t,
            woo,
            giftCode: giftCode ? giftCode.code : '',
            accessSource,
            conflict,
            groupId: assignedGroupId,
            group: assignedGroup,
        };
    }));

    const allRows = enriched.map(t => {
        const active = t.is_active === 1;
        const hasKeys = !!(t.recurrente_public_key && t.recurrente_secret_key);
        const mode = t.mode || 'test';
        const name = t.business_name || t.location_id;
        const wooActive = !!t.woo?.active;
        const subId = t.woo?.subscriptionId || '-';
        const exp = t.woo?.expiresAt || '-';
        const accessBadge = t.accessSource === 'gift'
            ? '<span class="badge gift">Regalo</span>'
            : t.accessSource === 'woo'
                ? '<span class="badge sub">Woo</span>'
                : '<span class="badge off">Sin acceso</span>';
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
                <span class="badge ${wooActive ? 'ok' : 'off'}">${wooActive ? 'Activa' : 'Inactiva'}</span>
                <br><small class="loc-id">ID: ${escapeHtml(subId)}</small>
                <br><small class="loc-id">Vence: ${escapeHtml(exp)}</small>
            </td>
            <td>${accessBadge}${t.giftCode ? '<br><small class="loc-id">' + escapeHtml(t.giftCode) + '</small>' : ''}</td>
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

    const wooTenants = enriched.filter((t: any) => t.accessSource === 'woo');
    const giftTenants = enriched.filter((t: any) => t.accessSource === 'gift');
    const noAccessTenants = enriched.filter((t: any) => t.accessSource === 'none');
    const conflictCount = enriched.filter((t: any) => t.conflict).length;

    const applyGroupFilter = (rows: any[], filter: string) => {
        if (!filter || filter === 'all') return rows;
        if (filter === 'none') return rows.filter((r: any) => !r.groupId);
        const id = Number(filter);
        if (!Number.isFinite(id) || id <= 0) return rows;
        return rows.filter((r: any) => r.groupId === id);
    };

    const wooFiltered = applyGroupFilter(wooTenants, wooGroupFilter);
    const giftFiltered = applyGroupFilter(giftTenants, giftGroupFilter);

    const subscriptionCount = wooTenants.length;
    const giftCount = giftTenants.length;
    const noAccessCount = enriched.filter((t: any) => t.accessSource === 'none').length;

    const buildGroupOptions = (sourceType: GroupSource, selected: number | null) => {
        const rows = groupsBySource[sourceType];
        const options = ['<option value="">Sin grupo</option>'];
        for (const g of rows) {
            options.push(`<option value="${g.id}" ${selected === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`);
        }
        return options.join('');
    };

    const buildTenantRows = (rows: any[], sourceType: GroupSource) => rows.map((t: any) => {
        const active = t.is_active === 1;
        const hasKeys = !!(t.recurrente_public_key && t.recurrente_secret_key);
        const mode = t.mode || 'test';
        const name = t.business_name || t.location_id;
        const wooActive = !!t.woo?.active;
        const subId = t.woo?.subscriptionId || '-';
        const exp = t.woo?.expiresAt || '-';
        const conflictBadge = t.conflict ? '<br><span class="badge warn">Conflicto Woo+Código</span>' : '';

        return `
        <tr class="${active ? '' : 'inactive'}">
            <td>
                <strong>${escapeHtml(name)}</strong>
                <br><small class="loc-id">${escapeHtml(t.location_id)}</small>
                ${t.giftCode ? '<br><small class="loc-id">Código: ' + escapeHtml(t.giftCode) + '</small>' : ''}
                ${conflictBadge}
            </td>
            <td><span class="badge ${mode === 'live' ? 'live' : 'test'}">${mode.toUpperCase()}</span></td>
            <td><span class="badge ${hasKeys ? 'ok' : 'warn'}">${hasKeys ? 'Configuradas' : 'Sin llaves'}</span></td>
            <td><span class="badge ${t.has_token ? 'ok' : 'warn'}">${t.has_token ? 'Conectado' : 'Sin token'}</span></td>
            <td>
                <span class="badge ${wooActive ? 'ok' : 'off'}">${wooActive ? 'Activa' : 'Inactiva'}</span>
                <br><small class="loc-id">ID: ${escapeHtml(subId)}</small>
                <br><small class="loc-id">Vence: ${escapeHtml(exp)}</small>
            </td>
            <td>
                <select class="group-select" onchange="assignTenantGroup('${escapeHtml(t.location_id)}', '${sourceType}', this.value)">
                    ${buildGroupOptions(sourceType, t.groupId || null)}
                </select>
            </td>
            <td><span class="badge ${active ? 'ok' : 'off'}">${active ? 'Autorizada' : 'Bloqueada'}</span></td>
            <td>
                <button class="btn ${active ? 'btn-danger' : 'btn-success'}"
                    onclick="toggleTenant('${escapeHtml(t.location_id)}', ${!active})">
                    ${active ? 'Bloquear' : 'Autorizar'}
                </button>
            </td>
        </tr>`;
    }).join('');

    const wooRows = buildTenantRows(wooFiltered, 'woo');
    const giftRows = buildTenantRows(giftFiltered, 'gift');

    const groupFilterOptions = (sourceType: GroupSource, current: string) => {
        const items = ['<option value="all">Todos</option>', '<option value="none">Sin grupo</option>'];
        for (const g of groupsBySource[sourceType]) {
            items.push(`<option value="${g.id}" ${current === String(g.id) ? 'selected' : ''}>${escapeHtml(g.name)}</option>`);
        }
        return items.join('');
    };

    const giftRowsHtml = giftCodeRows.map((c: any) => `
        <tr>
            <td><strong>${escapeHtml(c.code || '')}</strong></td>
            <td>${c.is_used === 1 ? '<span class="badge ok">Usado</span>' : '<span class="badge warn">Disponible</span>'}</td>
            <td><small class="loc-id">${escapeHtml(c.location_id || '-')}</small></td>
            <td><small class="loc-id">${escapeHtml(c.created_at || '-')}</small></td>
            <td><small class="loc-id">${escapeHtml(c.notes || '-')}</small></td>
            <td><button class="btn btn-danger" onclick="deleteGiftCode(${Number(c.id) || 0}, '${escapeHtml(c.code || '')}')">Borrar</button></td>
        </tr>
    `).join('');

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
    .badge.sub { background: #1e3a8a; color: #93c5fd; }
    .badge.gift { background: #6d28d9; color: #e9d5ff; }
    .btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.8; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-success { background: #16a34a; color: white; }
    .btn-danger { background: #dc2626; color: white; }
    .btn-generate { background: #7c3aed; color: white; }
    .section { margin-top: 24px; background: #1e293b; border-radius: 8px; padding: 16px; }
    .section h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 12px; }
    .row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; margin-bottom: 10px; }
    .row input { width: 100%; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 10px; border-radius: 6px; }
    .row select { width: 100%; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 10px; border-radius: 6px; }
    .group-select { width: 100%; min-width: 170px; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 7px 8px; border-radius: 6px; }
    .inline-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .inline-tools label { color: #94a3b8; font-size: 0.85rem; }
    .inline-tools select { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 8px; border-radius: 6px; min-width: 170px; }
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
        <div class="stat-card">
            <div class="num">${subscriptionCount}</div>
            <div class="label">Cuentas Woo</div>
        </div>
        <div class="stat-card">
            <div class="num">${giftCount}</div>
            <div class="label">Cuentas regalo</div>
        </div>
        <div class="stat-card">
            <div class="num">${noAccessCount}</div>
            <div class="label">Sin acceso</div>
        </div>
        <div class="stat-card">
            <div class="num">${conflictCount}</div>
            <div class="label">Conflictos Woo+Código</div>
        </div>
    </div>

    <div class="section" style="margin-top:0;">
        <h2>Grupos</h2>
        <div class="row" style="grid-template-columns: 180px 1fr 140px auto;">
            <select id="groupSourceType">
                <option value="woo">WooCommerce</option>
                <option value="gift">Códigos regalo</option>
            </select>
            <input id="groupName" placeholder="Nombre de grupo" />
            <input id="groupColor" type="color" value="#1e3a8a" />
            <button class="btn btn-generate" onclick="createTenantGroup()">Crear grupo</button>
        </div>
        <div class="inline-tools">
            <label for="wooGroupFilter">Filtro Woo</label>
            <select id="wooGroupFilter">${groupFilterOptions('woo', wooGroupFilter)}</select>
            <label for="giftGroupFilter">Filtro Códigos</label>
            <select id="giftGroupFilter">${groupFilterOptions('gift', giftGroupFilter)}</select>
            <button class="btn btn-success" onclick="applyGroupFilters()">Aplicar filtros</button>
        </div>
    </div>

    <div class="section">
        <h2>Sub-cuentas WooCommerce (${wooFiltered.length})</h2>
        <table>
            <thead>
                <tr>
                    <th>Sub-cuenta</th>
                    <th>Modo</th>
                    <th>Llaves Recurrente</th>
                    <th>Token GHL</th>
                    <th>Suscripción Woo</th>
                    <th>Grupo Woo</th>
                    <th>Estado</th>
                    <th>Acción</th>
                </tr>
            </thead>
            <tbody>${wooRows || '<tr><td colspan="8" style="text-align:center;padding:24px;color:#94a3b8;">No hay sub-cuentas Woo para este filtro</td></tr>'}</tbody>
        </table>
    </div>

    <div class="section">
        <h2>Sub-cuentas por Códigos (${giftFiltered.length})</h2>
        <table>
            <thead>
                <tr>
                    <th>Sub-cuenta</th>
                    <th>Modo</th>
                    <th>Llaves Recurrente</th>
                    <th>Token GHL</th>
                    <th>Suscripción Woo</th>
                    <th>Grupo Códigos</th>
                    <th>Estado</th>
                    <th>Acción</th>
                </tr>
            </thead>
            <tbody>${giftRows || '<tr><td colspan="8" style="text-align:center;padding:24px;color:#94a3b8;">No hay sub-cuentas de códigos para este filtro</td></tr>'}</tbody>
        </table>
    </div>

    <div class="section">
        <h2>Sub-cuentas sin acceso (${noAccessTenants.length})</h2>
        <table>
            <thead>
                <tr>
                    <th>Sub-cuenta</th>
                    <th>Estado</th>
                    <th>Acción</th>
                </tr>
            </thead>
            <tbody>${noAccessTenants.map((t: any) => {
                const active = t.is_active === 1;
                const name = t.business_name || t.location_id;
                return `<tr>
                    <td><strong>${escapeHtml(name)}</strong><br><small class="loc-id">${escapeHtml(t.location_id)}</small></td>
                    <td><span class="badge ${active ? 'ok' : 'off'}">${active ? 'Autorizada' : 'Bloqueada'}</span></td>
                    <td><button class="btn ${active ? 'btn-danger' : 'btn-success'}" onclick="toggleTenant('${escapeHtml(t.location_id)}', ${!active})">${active ? 'Bloquear' : 'Autorizar'}</button></td>
                </tr>`;
            }).join('') || '<tr><td colspan="3" style="text-align:center;padding:18px;color:#94a3b8;">Sin sub-cuentas en este estado</td></tr>'}</tbody>
        </table>
    </div>

    <div class="section">
        <h2>Resumen general</h2>
        <table>
        <thead>
            <tr>
                <th>Sub-cuenta</th>
                <th>Modo</th>
                <th>Llaves Recurrente</th>
                <th>Token GHL</th>
                <th>Suscripción Woo</th>
                <th>Origen acceso</th>
                <th>Estado</th>
                <th>Acción</th>
            </tr>
        </thead>
        <tbody>${allRows || '<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8;">No hay sub-cuentas configuradas</td></tr>'}</tbody>
        </table>
    </div>

    <div class="section">
        <h2>Cuentas regalo / Códigos de activación</h2>
        <div class="row">
            <input id="giftCode" placeholder="Código (opcional, auto: EPIC-GTXXXXXXXXXXX)" />
            <input id="giftNote" placeholder="Nota (opcional)" />
            <button class="btn btn-generate" onclick="createGiftCode(false)">Crear código</button>
        </div>
        <div class="row" style="grid-template-columns: 1fr auto;">
            <input id="giftLocationId" placeholder="Location ID para asignar código (opcional)" />
            <button class="btn btn-success" onclick="createGiftCode(true)">Generar y asignar</button>
        </div>
        <table style="margin-top:12px;">
            <thead>
                <tr>
                    <th>Código</th>
                    <th>Estado</th>
                    <th>Location ID</th>
                    <th>Creado</th>
                    <th>Nota</th>
                    <th>Acción</th>
                </tr>
            </thead>
            <tbody>${giftRowsHtml || '<tr><td colspan="6" style="text-align:center;padding:18px;color:#94a3b8;">Sin códigos todavía</td></tr>'}</tbody>
        </table>
    </div>
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

async function createGiftCode(assignNow) {
    const code = (document.getElementById('giftCode').value || '').trim();
    const notes = (document.getElementById('giftNote').value || '').trim();
    const locationId = (document.getElementById('giftLocationId').value || '').trim();

    try {
        const createRes = await fetch('/admin/gift-codes/create?adminKey=' + encodeURIComponent(ADMIN_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, notes })
        });
        const createData = await createRes.json();
        if (!createData.success) {
            showToast('Error creando código: ' + (createData.error || 'desconocido'), 'err');
            return;
        }

        const generatedCode = createData.code;
        if (assignNow) {
            if (!locationId) {
                showToast('Código creado: ' + generatedCode + ' (faltó locationId para asignar)', 'ok');
                setTimeout(() => location.reload(), 900);
                return;
            }
            const redeemRes = await fetch('/admin/gift-codes/redeem?adminKey=' + encodeURIComponent(ADMIN_KEY), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locationId, code: generatedCode })
            });
            const redeemData = await redeemRes.json();
            if (!redeemData.success) {
                showToast('Código creado pero no asignado: ' + (redeemData.error || 'error'), 'err');
                return;
            }
            showToast('Código ' + generatedCode + ' asignado a ' + locationId, 'ok');
        } else {
            showToast('Código creado: ' + generatedCode, 'ok');
        }

        setTimeout(() => location.reload(), 900);
    } catch {
        showToast('Error de red creando código', 'err');
    }
}

function applyGroupFilters() {
    const wooGroup = (document.getElementById('wooGroupFilter').value || 'all');
    const giftGroup = (document.getElementById('giftGroupFilter').value || 'all');
    const url = new URL(location.href);
    url.searchParams.set('wooGroup', wooGroup);
    url.searchParams.set('giftGroup', giftGroup);
    if (ADMIN_KEY) url.searchParams.set('adminKey', ADMIN_KEY);
    location.href = url.toString();
}

async function createTenantGroup() {
    const sourceType = (document.getElementById('groupSourceType').value || '').trim();
    const name = (document.getElementById('groupName').value || '').trim();
    const color = (document.getElementById('groupColor').value || '').trim();
    if (!name) {
        showToast('Ingresa nombre de grupo', 'err');
        return;
    }

    try {
        const res = await fetch('/admin/groups/create?adminKey=' + encodeURIComponent(ADMIN_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceType, name, color })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Error creando grupo: ' + (data.error || 'desconocido'), 'err');
            return;
        }
        showToast('Grupo creado', 'ok');
        setTimeout(() => location.reload(), 700);
    } catch {
        showToast('Error de red creando grupo', 'err');
    }
}

async function assignTenantGroup(locationId, sourceType, groupIdValue) {
    const groupId = groupIdValue ? Number(groupIdValue) : null;
    try {
        const res = await fetch('/admin/groups/assign?adminKey=' + encodeURIComponent(ADMIN_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locationId, sourceType, groupId })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Error asignando grupo: ' + (data.error || 'desconocido'), 'err');
            setTimeout(() => location.reload(), 800);
            return;
        }
        showToast(data.message || 'Grupo actualizado', 'ok');
    } catch {
        showToast('Error de red asignando grupo', 'err');
    }
}

async function deleteGiftCode(id, code) {
    if (!id) {
        showToast('ID de código inválido', 'err');
        return;
    }
    const confirmed = confirm('¿Borrar el código ' + code + '? Esta acción no se puede deshacer.');
    if (!confirmed) return;

    try {
        const res = await fetch('/admin/gift-codes/delete?adminKey=' + encodeURIComponent(ADMIN_KEY), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Error borrando código: ' + (data.error || 'desconocido'), 'err');
            return;
        }
        showToast(data.message || 'Código eliminado', 'ok');
        setTimeout(() => location.reload(), 700);
    } catch {
        showToast('Error de red borrando código', 'err');
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
