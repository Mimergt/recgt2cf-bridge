/**
 * Recurrente API Client
 *
 * Docs: https://recurrente.com (API section)
 * Base URL: https://app.recurrente.com/api
 *
 * Authentication: X-PUBLIC-KEY and X-SECRET-KEY headers
 */

const RECURRENTE_API_BASE = 'https://app.recurrente.com/api';

interface RecurrenteCredentials {
    publicKey: string;
    secretKey: string;
}

// ─── Create Checkout ────────────────────────────────────────

export interface CreateCheckoutParams {
    /** Amount in cents (e.g. 10000 = Q100.00) */
    amount_in_cents: number;
    /** Currency code: GTQ or USD */
    currency: string;
    /** Product/item name shown to customer */
    product_name: string;
    /** URL to redirect after successful payment */
    success_url: string;
    /** URL to redirect if cancelled */
    cancel_url: string;
    /** Optional customer email */
    email?: string;
    /** Metadata to track this payment (e.g. GHL chargeId) */
    metadata?: Record<string, string>;
}

export interface RecurrenteCheckout {
    id: string;
    checkout_url: string;
    status: string;
}

/**
 * Create a checkout session on Recurrente.
 * This generates a payment URL that the customer can use to pay.
 */
export async function createCheckout(
    creds: RecurrenteCredentials,
    params: CreateCheckoutParams
): Promise<RecurrenteCheckout> {
    const body = {
        items: [
            {
                name: params.product_name,
                currency: params.currency || 'GTQ',
                amount_in_cents: params.amount_in_cents,
                quantity: 1,
            },
        ],
        success_url: params.success_url,
        cancel_url: params.cancel_url,
        ...(params.email && { user: { email: params.email } }),
        ...(params.metadata && { metadata: params.metadata }),
    };

    const response = await fetch(`${RECURRENTE_API_BASE}/checkouts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-PUBLIC-KEY': creds.publicKey,
            'X-SECRET-KEY': creds.secretKey,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Recurrente API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<RecurrenteCheckout>;
}

// ─── Get Checkout Status ────────────────────────────────────

export interface RecurrenteCheckoutStatus {
    id: string;
    status: string;
    amount_in_cents: number;
    currency: string;
    payment_id?: string;
    paid_at?: string;
    metadata?: Record<string, string>;
}

/**
 * Get the current status of a checkout session.
 */
export async function getCheckoutStatus(
    creds: RecurrenteCredentials,
    checkoutId: string
): Promise<RecurrenteCheckoutStatus> {
    const response = await fetch(`${RECURRENTE_API_BASE}/checkouts/${checkoutId}`, {
        method: 'GET',
        headers: {
            'X-PUBLIC-KEY': creds.publicKey,
            'X-SECRET-KEY': creds.secretKey,
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Recurrente API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<RecurrenteCheckoutStatus>;
}

// ─── Helper: Convert GHL amount to cents ────────────────────

/**
 * GHL sends amounts in the main currency unit (e.g. 100.00).
 * Recurrente expects cents (e.g. 10000).
 */
export function toCents(amount: number): number {
    return Math.round(amount * 100);
}

/**
 * Convert cents to main currency unit.
 */
export function fromCents(amountInCents: number): number {
    return amountInCents / 100;
}
