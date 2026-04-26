import type { Env } from './types';
import { jsonResponse } from './router';
import { getActiveGateway, getGatewayActiveCredentials } from './db';
import { createCheckout } from './recurrente';
import { createTransaction, updateTransactionByChargeId } from './db';

// Handler for incoming GHL webhooks that create charges/invoices
export async function handleGhlWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;

    // Basic event extraction (support several possible shapes)
    const eventType = body.event || body.type || body.action || body.eventType || null;
    const payload = body.data || body.payload || body || {};

    // Try to find locationId and charge/invoice id and amount
    const locationId = payload.locationId || payload.location_id || body.locationId || body.location_id || null;
    const chargeId = payload.id || payload.chargeId || payload.invoiceId || payload.invoice_id || null;
    const amount = payload.amount || payload.total || payload.subtotal || payload.price || null;
    const currency = payload.currency || payload.currency_code || 'GTQ';
    const contactEmail = payload.email || payload.contact_email || payload.contactEmail || '';
    const contactName = payload.name || payload.contact_name || payload.contactName || '';
    const description = payload.description || payload.title || 'Pago GHL via webhook';

    if (!locationId || !chargeId || !amount) {
      return jsonResponse({ success: false, error: 'Missing locationId, chargeId or amount in webhook payload' }, 400);
    }

    // Feature toggle: check if webhook processing is enabled for this location
    const { getSetting } = await import('./db');
    const enabled = await getSetting(env.DB, `webhook_enabled:${locationId}`);
    if (enabled !== '1') {
      return jsonResponse({ success: true, message: 'Webhook received but pre-creation disabled for this location' });
    }

    // Resolve active gateway for this sub-account (legacy tenants fallback handled in db.ts)
    const activeGateway = await getActiveGateway(env.DB, locationId);
    if (!activeGateway) {
      return jsonResponse({ success: false, error: 'No active gateway configured for this location', code: 'NO_ACTIVE_GATEWAY' }, 409);
    }
    if (activeGateway.gateway_type !== 'recurrente') {
      return jsonResponse({ success: false, error: `Gateway ${activeGateway.gateway_type} not yet supported`, code: 'GATEWAY_NOT_IMPLEMENTED' }, 501);
    }
    const gatewayCreds = getGatewayActiveCredentials(activeGateway);

    // Create Recurrente checkout
    const checkout = await createCheckout(
      {
        publicKey: String(gatewayCreds.publicKey || ''),
        secretKey: String(gatewayCreds.secretKey || ''),
      },
      {
        amount_in_cents: Math.round(Number(amount) * 100),
        currency: currency || 'GTQ',
        product_name: description,
        success_url: `${new URL(request.url).origin}/payment/success?charge_id=${chargeId}`,
        cancel_url: `${new URL(request.url).origin}/payment/cancel?charge_id=${chargeId}`,
        email: contactEmail,
        metadata: {
          ghl_charge_id: chargeId,
          ghl_location_id: locationId,
          contact_name: contactName,
        },
      }
    );

    // Persist transaction (or update existing)
    try {
      await createTransaction(env.DB, {
        location_id: locationId,
        ghl_charge_id: chargeId,
        recurrente_checkout_id: checkout.id,
        amount: Math.round(Number(amount) * 100),
        currency: currency || 'GTQ',
        status: 'pending',
        meta: { recurrente_checkout_url: checkout.checkout_url },
      });
    } catch (e) {
      // If insert fails because transaction exists, update
      await updateTransactionByChargeId(env.DB, chargeId, 'pending');
    }

    return jsonResponse({ success: true, checkout_url: checkout.checkout_url, checkout_id: checkout.id });
  } catch (error) {
    console.error('[webhook] Error processing GHL webhook', error);
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
