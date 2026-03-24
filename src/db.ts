import type { Env, Tenant, Transaction } from './types';

// ─── Tenant Operations ─────────────────────────────────────

/** Get tenant config by GHL locationId */
export async function getTenant(db: D1Database, locationId: string): Promise<Tenant | null> {
    const result = await db
        .prepare('SELECT * FROM tenants WHERE location_id = ? AND is_active = 1')
        .bind(locationId)
        .first<Tenant>();
    return result;
}

/** Create or update tenant config */
export async function upsertTenant(
    db: D1Database,
    locationId: string,
    data: {
        publicKey?: string;
        secretKey?: string;
        publicKeyLive?: string;
        secretKeyLive?: string;
        mode?: 'test' | 'live';
        businessName?: string;
    }
): Promise<void> {
    // Ensure new columns exist (safe to run each time)
    const migrations = [
        "ALTER TABLE tenants ADD COLUMN recurrente_public_key_live TEXT DEFAULT ''",
        "ALTER TABLE tenants ADD COLUMN recurrente_secret_key_live TEXT DEFAULT ''",
        "ALTER TABLE tenants ADD COLUMN mode TEXT DEFAULT 'test'",
    ];
    for (const sql of migrations) {
        try { await db.prepare(sql).run(); } catch {}
    }

    // Check if tenant already exists
    const existing = await db.prepare('SELECT * FROM tenants WHERE location_id = ?').bind(locationId).first<Tenant>();

    if (existing) {
        // Only update fields that were actually provided
        const sets: string[] = [];
        const vals: any[] = [];
        if (data.publicKey !== undefined) { sets.push('recurrente_public_key = ?'); vals.push(data.publicKey); }
        if (data.secretKey !== undefined) { sets.push('recurrente_secret_key = ?'); vals.push(data.secretKey); }
        if (data.publicKeyLive !== undefined) { sets.push('recurrente_public_key_live = ?'); vals.push(data.publicKeyLive); }
        if (data.secretKeyLive !== undefined) { sets.push('recurrente_secret_key_live = ?'); vals.push(data.secretKeyLive); }
        if (data.mode !== undefined) { sets.push('mode = ?'); vals.push(data.mode); }
        if (data.businessName !== undefined) { sets.push('business_name = ?'); vals.push(data.businessName); }
        if (sets.length === 0) return;
        sets.push("updated_at = datetime('now')");
        vals.push(locationId);
        await db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE location_id = ?`).bind(...vals).run();
    } else {
        await db
            .prepare(
                `INSERT INTO tenants (location_id, recurrente_public_key, recurrente_secret_key, recurrente_public_key_live, recurrente_secret_key_live, mode, business_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
                locationId,
                data.publicKey || '',
                data.secretKey || '',
                data.publicKeyLive || '',
                data.secretKeyLive || '',
                data.mode || 'test',
                data.businessName || ''
            )
            .run();
    }
}

/** Get the active Recurrente keys for a tenant (based on mode) */
export function getActiveKeys(tenant: Tenant): { publicKey: string; secretKey: string } {
    if (tenant.mode === 'live' && tenant.recurrente_public_key_live && tenant.recurrente_secret_key_live) {
        return { publicKey: tenant.recurrente_public_key_live, secretKey: tenant.recurrente_secret_key_live };
    }
    return { publicKey: tenant.recurrente_public_key, secretKey: tenant.recurrente_secret_key };
}

/** List all tenants */
export async function listTenants(db: D1Database): Promise<Tenant[]> {
    const { results } = await db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all<Tenant>();
    return results;
}

/** Toggle tenant is_active flag */
export async function toggleTenant(db: D1Database, locationId: string, active: boolean): Promise<void> {
    await db.prepare('UPDATE tenants SET is_active = ?, updated_at = datetime(\'now\') WHERE location_id = ?')
        .bind(active ? 1 : 0, locationId).run();
}

/** List all tenants with their GHL token status */
export async function listTenantsWithTokens(db: D1Database): Promise<any[]> {
    const { results } = await db.prepare(`
        SELECT t.*, 
            gt.access_token IS NOT NULL as has_token,
            gt.expires_at as token_expires_at
        FROM tenants t
        LEFT JOIN ghl_tokens gt ON t.location_id = gt.location_id
        ORDER BY t.created_at DESC
    `).all();
    return results;
}

/** Delete tenant by locationId */
export async function deleteTenant(db: D1Database, locationId: string): Promise<void> {
    await db.prepare('DELETE FROM tenants WHERE location_id = ?').bind(locationId).run();
}

// ─── Transaction Operations ────────────────────────────────

/** Log a new transaction */
export async function createTransaction(
    db: D1Database,
    data: {
        location_id: string;
        ghl_charge_id?: string;
        recurrente_checkout_id?: string;
        amount: number;
        currency: string;
        status?: string;
        meta?: Record<string, unknown>;
    }
): Promise<void> {
    await db
        .prepare(
            `INSERT INTO transactions (location_id, ghl_charge_id, recurrente_checkout_id, amount, currency, status, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            data.location_id,
            data.ghl_charge_id || null,
            data.recurrente_checkout_id || null,
            data.amount,
            data.currency,
            data.status || 'pending',
            JSON.stringify(data.meta || {})
        )
        .run();
}

/** Update transaction status by Recurrente checkout ID */
export async function updateTransactionByCheckout(
    db: D1Database,
    checkoutId: string,
    status: string,
    paymentId?: string
): Promise<void> {
    await db
        .prepare(
            `UPDATE transactions
       SET status = ?, recurrente_payment_id = ?, updated_at = datetime('now')
       WHERE recurrente_checkout_id = ?`
        )
        .bind(status, paymentId || null, checkoutId)
        .run();
}

/** Update transaction status by GHL charge ID */
export async function updateTransactionByChargeId(
    db: D1Database,
    chargeId: string,
    status: string,
    paymentId?: string
): Promise<void> {
    await db
        .prepare(
            `UPDATE transactions
       SET status = ?, recurrente_payment_id = ?, updated_at = datetime('now')
       WHERE ghl_charge_id = ?`
        )
        .bind(status, paymentId || null, chargeId)
        .run();
}

/** Get transaction by GHL charge ID */
export async function getTransactionByChargeId(
    db: D1Database,
    chargeId: string
): Promise<Transaction | null> {
    return db
        .prepare('SELECT * FROM transactions WHERE ghl_charge_id = ? ORDER BY id DESC LIMIT 1')
        .bind(chargeId)
        .first<Transaction>();
}

/** Get all transactions pending a GHL record-payment retry (via cron) */
export async function getGhlPendingTransactions(db: D1Database): Promise<Transaction[]> {
    const { results } = await db
        .prepare(`SELECT * FROM transactions WHERE status = 'ghl_pending' AND updated_at > datetime('now', '-2 hours') ORDER BY updated_at ASC LIMIT 20`)
        .all<Transaction>();
    return results;
}

/** Get transaction by Recurrente checkout ID */
export async function getTransactionByCheckoutId(
    db: D1Database,
    checkoutId: string
): Promise<Transaction | null> {
    return db
        .prepare('SELECT * FROM transactions WHERE recurrente_checkout_id = ?')
        .bind(checkoutId)
        .first<Transaction>();
}

// ─── GHL Token Persistence ─────────────────────────────────

/** Ensure token table exists and upsert token for a location */
export async function upsertGhlToken(
    db: D1Database,
    locationId: string,
    accessToken: string,
    refreshToken?: string | null,
    scopes?: string | null,
    expiresAt?: string | null
): Promise<void> {
    // Create table if missing (safe to run on each call)
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS ghl_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id TEXT NOT NULL UNIQUE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scopes TEXT,
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )`
    ).run();

    await db
        .prepare(
            `INSERT INTO ghl_tokens (location_id, access_token, refresh_token, scopes, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           scopes = excluded.scopes,
           expires_at = excluded.expires_at,
           updated_at = datetime('now')`
        )
        .bind(locationId, accessToken, refreshToken || null, scopes || null, expiresAt || null)
        .run();
}

/** Retrieve GHL token row by location */
export async function getGhlToken(db: D1Database, locationId: string) {
    return db
        .prepare('SELECT * FROM ghl_tokens WHERE location_id = ?')
        .bind(locationId)
        .first();
}

/**
 * Get a valid (non-expired) GHL access token, refreshing automatically if needed.
 * Returns the token row with a guaranteed-fresh access_token, or null if refresh fails.
 */
export async function getValidGhlToken(
    db: D1Database,
    locationId: string,
    clientId: string,
    clientSecret: string
): Promise<{ access_token: string; refresh_token: string | null; location_id: string } | null> {
    const row = await getGhlToken(db, locationId) as any;
    if (!row) return null;

    // Check if token is expired or expiring within 10 minutes
    if (row.expires_at) {
        const expiresAt = new Date(row.expires_at).getTime();
        const buffer = 10 * 60 * 1000; // 10 minutes
        if (Date.now() + buffer >= expiresAt) {
            console.log('[TokenRefresh] Token expiring soon for', locationId, '- refreshing');
            const refreshed = await refreshGhlToken(db, locationId, row.refresh_token, clientId, clientSecret);
            if (refreshed) return refreshed;
            // Refresh failed — return existing token as last resort (may still work briefly)
            console.error('[TokenRefresh] Refresh failed, using existing token for', locationId);
        }
    }

    return { access_token: row.access_token, refresh_token: row.refresh_token, location_id: row.location_id };
}

/**
 * Refresh a GHL OAuth token using the refresh_token grant.
 * On success, updates D1 and returns the new token row.
 */
export async function refreshGhlToken(
    db: D1Database,
    locationId: string,
    refreshToken: string | null,
    clientId: string,
    clientSecret: string
): Promise<{ access_token: string; refresh_token: string | null; location_id: string } | null> {
    if (!refreshToken) {
        console.error('[TokenRefresh] No refresh_token for', locationId);
        return null;
    }

    try {
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            user_type: 'Location',
        });

        const res = await fetch('https://services.leadconnectorhq.com/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            body: body.toString(),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('[TokenRefresh] GHL returned', res.status, 'for', locationId, ':', errText);
            return null;
        }

        const data = await res.json() as any;
        const newAccessToken = data.access_token;
        const newRefreshToken = data.refresh_token || refreshToken;
        const expiresIn = data.expires_in; // seconds
        const expiresAt = expiresIn
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null;

        console.log('[TokenRefresh] Success for', locationId, '- expires_in:', expiresIn, 's');

        await upsertGhlToken(db, locationId, newAccessToken, newRefreshToken, data.scope || null, expiresAt);

        return { access_token: newAccessToken, refresh_token: newRefreshToken, location_id: locationId };
    } catch (e) {
        console.error('[TokenRefresh] Error for', locationId, ':', e);
        return null;
    }
}

/**
 * Get all tokens that are expiring within the given number of minutes.
 * Used by the cron job to proactively refresh tokens.
 */
export async function getExpiringTokens(db: D1Database, withinMinutes: number) {
    const cutoff = new Date(Date.now() + withinMinutes * 60 * 1000).toISOString();
    return db
        .prepare('SELECT * FROM ghl_tokens WHERE refresh_token IS NOT NULL AND (expires_at IS NULL OR expires_at <= ?)')
        .bind(cutoff)
        .all();
}

// ─── Simple Key/Value Settings ──────────────────────────────
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS bridge_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            value TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )`
    ).run();

    await db
        .prepare(
            `INSERT INTO bridge_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        )
        .bind(key, value)
        .run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS bridge_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            value TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )`
    ).run();

    const row = await db.prepare('SELECT value FROM bridge_settings WHERE key = ?').bind(key).first<{ value: string }>();
    return row ? row.value : null;
}
