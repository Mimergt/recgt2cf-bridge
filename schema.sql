-- GHL Recurrente Bridge - Database Schema
-- Maps GHL locationId to Recurrente credentials (multi-tenant)

-- Tenant configurations: one row per GHL location/sub-account
CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id TEXT NOT NULL UNIQUE,          -- GHL locationId (sub-account)
    recurrente_public_key TEXT NOT NULL,        -- Recurrente public API key
    recurrente_secret_key TEXT NOT NULL,        -- Recurrente secret API key
    business_name TEXT DEFAULT '',              -- Display name for the tenant
    is_active INTEGER DEFAULT 1,               -- 1 = active, 0 = disabled
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Payment transactions log
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id TEXT NOT NULL,                  -- GHL locationId
    ghl_charge_id TEXT,                         -- Charge ID from GHL
    recurrente_checkout_id TEXT,                -- Checkout ID from Recurrente
    recurrente_payment_id TEXT,                 -- Payment ID from Recurrente
    amount INTEGER NOT NULL,                    -- Amount in cents
    currency TEXT DEFAULT 'GTQ',                -- Currency code
    status TEXT DEFAULT 'pending',              -- pending, completed, failed, refunded
    meta TEXT DEFAULT '{}',                     -- JSON metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (location_id) REFERENCES tenants(location_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_tenants_location ON tenants(location_id);
CREATE INDEX IF NOT EXISTS idx_transactions_location ON transactions(location_id);
CREATE INDEX IF NOT EXISTS idx_transactions_ghl_charge ON transactions(ghl_charge_id);
CREATE INDEX IF NOT EXISTS idx_transactions_recurrente_checkout ON transactions(recurrente_checkout_id);

-- GHL OAuth tokens stored per location (for server-to-server calls)
CREATE TABLE IF NOT EXISTS ghl_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    scopes TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Bridge settings (key/value) for toggles like webhook_enabled per-location
CREATE TABLE IF NOT EXISTS bridge_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Manual activation codes for gifted access (non-Woo subscriptions)
CREATE TABLE IF NOT EXISTS manual_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    location_id TEXT,
    is_used INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_manual_activations_code ON manual_activations(code);
CREATE INDEX IF NOT EXISTS idx_manual_activations_location ON manual_activations(location_id);
