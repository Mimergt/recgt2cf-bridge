/**
 * Admin Handlers
 *
 * Endpoints for managing tenant configurations.
 * In production, these should be protected with authentication.
 */

import type { Env } from './types';
import { getTenant, upsertTenant, listTenants, deleteTenant } from './db';
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

    return jsonResponse({
        success: true,
        tenant: {
            ...tenant,
            recurrente_secret_key: tenant.recurrente_secret_key.slice(0, 8) + '...',
            recurrente_public_key: tenant.recurrente_public_key.slice(0, 8) + '...',
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
        publicKey: string;
        secretKey: string;
        businessName?: string;
    }>();

    if (!body.locationId || !body.publicKey || !body.secretKey) {
        return jsonResponse(
            { success: false, error: 'Missing required fields: locationId, publicKey, secretKey' },
            400
        );
    }

    await upsertTenant(env.DB, body.locationId, body.publicKey, body.secretKey, body.businessName || '');

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
