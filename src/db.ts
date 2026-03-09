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
    publicKey: string,
    secretKey: string,
    businessName: string = ''
): Promise<void> {
    await db
        .prepare(
            `INSERT INTO tenants (location_id, recurrente_public_key, recurrente_secret_key, business_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(location_id) DO UPDATE SET
         recurrente_public_key = excluded.recurrente_public_key,
         recurrente_secret_key = excluded.recurrente_secret_key,
         business_name = excluded.business_name,
         updated_at = datetime('now')`
        )
        .bind(locationId, publicKey, secretKey, businessName)
        .run();
}

/** List all tenants */
export async function listTenants(db: D1Database): Promise<Tenant[]> {
    const { results } = await db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all<Tenant>();
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
        .prepare('SELECT * FROM transactions WHERE ghl_charge_id = ?')
        .bind(chargeId)
        .first<Transaction>();
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
