export interface Env {
    DB: D1Database;
    GHL_CLIENT_ID: string;
    GHL_CLIENT_SECRET: string;
    ADMIN_SECRET: string;
}

// ─── Tenant / Multi-tenant ──────────────────────────────────
export interface Tenant {
    id: number;
    location_id: string;
    recurrente_public_key: string;
    recurrente_secret_key: string;
    recurrente_public_key_live: string;
    recurrente_secret_key_live: string;
    mode: 'test' | 'live';
    business_name: string;
    is_active: number;
    created_at: string;
    updated_at: string;
}

// ─── Transactions ───────────────────────────────────────────
export interface Transaction {
    id: number;
    location_id: string;
    ghl_charge_id: string | null;
    recurrente_checkout_id: string | null;
    recurrente_payment_id: string | null;
    amount: number;
    currency: string;
    status: 'pending' | 'completed' | 'failed' | 'refunded';
    meta: string;
    created_at: string;
    updated_at: string;
}

// ─── GHL Types ──────────────────────────────────────────────

/** GHL sends this payload when loading the paymentsUrl iframe */
export interface GHLPaymentPayload {
    type: string;
    locationId: string;
    chargeId: string;
    amount: number;
    currency: string;
    contactId?: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    description?: string;
    meta?: Record<string, unknown>;
}

/** GHL sends these actions to queryUrl */
export interface GHLQueryAction {
    type: string;
    locationId: string;
    chargeId?: string;
    subscriptionId?: string;
    amount?: number;
    currency?: string;
    meta?: Record<string, unknown>;
}

/** Standard response shape back to GHL */
export interface GHLPaymentResponse {
    success: boolean;
    message?: string;
    transactionId?: string;
    status?: string;
    data?: Record<string, unknown>;
}

// ─── Recurrente API Types ───────────────────────────────────

/** Request to create a checkout session on Recurrente */
export interface RecurrenteCheckoutRequest {
    items: RecurrenteItem[];
    success_url: string;
    cancel_url: string;
    user_id?: string;
    metadata?: Record<string, string>;
}

export interface RecurrenteItem {
    price_id?: string;
    currency: string;
    amount_in_cents: number;
    quantity: number;
    name?: string;
    image_url?: string;
}

/** Response from Recurrente when creating a checkout */
export interface RecurrenteCheckoutResponse {
    id: string;
    checkout_url: string;
    status: string;
}

/** Recurrente webhook event */
export interface RecurrenteWebhookEvent {
    id: string;
    type: string;
    data: {
        id: string;
        status: string;
        amount_in_cents: number;
        currency: string;
        checkout_id?: string;
        metadata?: Record<string, string>;
        [key: string]: unknown;
    };
}
