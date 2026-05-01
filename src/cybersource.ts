/**
 * CyberSource REST helper (Neonet)
 *
 * Uses HTTP Signature authentication required by CyberSource REST APIs.
 */

export interface CybersourceCredentials {
    merchantId: string;
    apiKeyId: string;
    sharedSecret: string;
    apiHost?: string;
}

export interface CybersourceConnectionResult {
    ok: boolean;
    status: number;
    message: string;
    body?: unknown;
}

const DEFAULT_CYBERSOURCE_HOST = 'apitest.cybersource.com';

function toUint8Array(binary: string): Uint8Array {
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        arr[i] = binary.charCodeAt(i);
    }
    return arr;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function sha256Base64(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return toBase64(new Uint8Array(digest));
}

async function hmacSha256Base64(keyBytes: Uint8Array, signingString: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signingString));
    return toBase64(new Uint8Array(signature));
}

async function buildCybersourceHeaders(
    creds: CybersourceCredentials,
    method: string,
    pathWithQuery: string,
    body: string
): Promise<Record<string, string>> {
    const host = creds.apiHost || DEFAULT_CYBERSOURCE_HOST;
    const date = new Date().toUTCString();
    const digest = `SHA-256=${await sha256Base64(body)}`;

    const signingString = [
        `host: ${host}`,
        `date: ${date}`,
        `(request-target): ${method.toLowerCase()} ${pathWithQuery}`,
        `digest: ${digest}`,
        `v-c-merchant-id: ${creds.merchantId}`,
    ].join('\n');

    const keyRaw = atob(creds.sharedSecret);
    const keyBytes = toUint8Array(keyRaw);
    const signatureValue = await hmacSha256Base64(keyBytes, signingString);

    const signature = [
        `keyid=\"${creds.apiKeyId}\"`,
        'algorithm="HmacSHA256"',
        'headers="host date (request-target) digest v-c-merchant-id"',
        `signature=\"${signatureValue}\"`,
    ].join(', ');

    return {
        Host: host,
        Date: date,
        Digest: digest,
        'v-c-merchant-id': creds.merchantId,
        Signature: signature,
        'Content-Type': 'application/json',
        Accept: 'application/hal+json;charset=utf-8',
    };
}

/**
 * Performs a real sandbox auth request (capture=false) using a CyberSource test card
 * to validate credentials and network connectivity.
 */
export async function testCybersourceConnection(
    creds: CybersourceCredentials
): Promise<CybersourceConnectionResult> {
    const host = creds.apiHost || DEFAULT_CYBERSOURCE_HOST;
    const path = '/pts/v2/payments';

    const requestBody = {
        clientReferenceInformation: {
            code: `neonet-connectivity-${Date.now()}`,
        },
        processingInformation: {
            capture: false,
        },
        orderInformation: {
            amountDetails: {
                totalAmount: '1.00',
                currency: 'USD',
            },
            billTo: {
                firstName: 'Sandbox',
                lastName: 'Tester',
                address1: '1 Market St',
                locality: 'San Francisco',
                administrativeArea: 'CA',
                postalCode: '94105',
                country: 'US',
                email: 'test@example.com',
            },
        },
        paymentInformation: {
            card: {
                number: '4111111111111111',
                expirationMonth: '12',
                expirationYear: '2031',
            },
        },
    };

    const body = JSON.stringify(requestBody);
    const headers = await buildCybersourceHeaders(creds, 'POST', path, body);

    const response = await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers,
        body,
    });

    let payload: unknown;
    const text = await response.text();
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = { raw: text };
    }

    if (response.ok) {
        return {
            ok: true,
            status: response.status,
            message: 'CyberSource sandbox connection verified',
            body: payload,
        };
    }

    if (response.status === 401 || response.status === 403) {
        return {
            ok: false,
            status: response.status,
            message: 'CyberSource credentials rejected (401/403)',
            body: payload,
        };
    }

    return {
        ok: false,
        status: response.status,
        message: 'CyberSource reachable but test auth request failed',
        body: payload,
    };
}
