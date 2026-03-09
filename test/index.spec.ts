import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Initialize database schema before tests
beforeAll(async () => {
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, location_id TEXT NOT NULL UNIQUE, recurrente_public_key TEXT NOT NULL, recurrente_secret_key TEXT NOT NULL, business_name TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))"
	);
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, location_id TEXT NOT NULL, ghl_charge_id TEXT, recurrente_checkout_id TEXT, recurrente_payment_id TEXT, amount INTEGER NOT NULL, currency TEXT DEFAULT 'GTQ', status TEXT DEFAULT 'pending', meta TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))"
	);
});

describe('GHL Recurrente Bridge', () => {
	// ─── Root ────────────────────────────────────────────────
	it('GET / returns service info', async () => {
		const request = new IncomingRequest('http://localhost/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json<{ service: string }>();
		expect(body.service).toBe('GHL Recurrente Bridge');
	});

	// ─── Health ──────────────────────────────────────────────
	it('GET /health returns ok with DB connected', async () => {
		const request = new IncomingRequest('http://localhost/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json<{ status: string; database: string }>();
		expect(body.status).toBe('ok');
		expect(body.database).toBe('connected');
	});

	// ─── 404 ─────────────────────────────────────────────────
	it('returns 404 for unknown routes', async () => {
		const request = new IncomingRequest('http://localhost/nonexistent');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});

	// ─── CORS ────────────────────────────────────────────────
	it('OPTIONS request returns CORS headers', async () => {
		const request = new IncomingRequest('http://localhost/health', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	// ─── Payment Page ────────────────────────────────────────
	it('GET /payment returns HTML page', async () => {
		const request = new IncomingRequest('http://localhost/payment');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		const html = await response.text();
		expect(html).toContain('Preparando checkout');
	});

	// ─── Admin: Create Tenant ────────────────────────────────
	it('POST /admin/tenant creates a new tenant', async () => {
		const request = new IncomingRequest('http://localhost/admin/tenant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				locationId: 'test-location-123',
				publicKey: 'pk_test_123456789',
				secretKey: 'sk_test_987654321',
				businessName: 'Test Business',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json<{ success: boolean }>();
		expect(body.success).toBe(true);
	});

	// ─── Admin: List Tenants ─────────────────────────────────
	it('GET /admin/tenants returns list of tenants', async () => {
		// Insert a tenant first so the list is not empty
		await env.DB.prepare(
			"INSERT OR IGNORE INTO tenants (location_id, recurrente_public_key, recurrente_secret_key, business_name) VALUES (?, ?, ?, ?)"
		).bind('list-test-loc', 'pk_test', 'sk_test', 'List Test').run();

		const request = new IncomingRequest('http://localhost/admin/tenants');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json<{ success: boolean; tenants: unknown[] }>();
		expect(body.success).toBe(true);
		expect(body.tenants.length).toBeGreaterThan(0);
	});

	// ─── Admin: Validation ───────────────────────────────────
	it('POST /admin/tenant returns 400 for missing fields', async () => {
		const request = new IncomingRequest('http://localhost/admin/tenant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ locationId: 'test' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	// ─── Create Checkout: Missing Tenant ─────────────────────
	it('POST /api/create-checkout returns 404 for unknown tenant', async () => {
		const request = new IncomingRequest('http://localhost/api/create-checkout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				locationId: 'nonexistent-location',
				chargeId: 'charge-123',
				amount: 100,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});

	// ─── Create Checkout: Missing Fields ─────────────────────
	it('POST /api/create-checkout returns 400 for missing fields', async () => {
		const request = new IncomingRequest('http://localhost/api/create-checkout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ locationId: 'test' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	// ─── Query URL: Missing Fields ───────────────────────────
	it('POST /api/query returns 400 for missing type', async () => {
		const request = new IncomingRequest('http://localhost/api/query', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ locationId: 'test' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});
});
