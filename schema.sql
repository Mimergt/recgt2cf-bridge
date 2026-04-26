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

-- Grouping for tenant organization (separate namespaces for Woo and Gift)
CREATE TABLE IF NOT EXISTS tenant_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('woo', 'gift')),
    color TEXT DEFAULT '#2563eb',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, source_type)
);

CREATE TABLE IF NOT EXISTS tenant_group_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('woo', 'gift')),
    group_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(location_id, source_type),
    FOREIGN KEY (group_id) REFERENCES tenant_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_groups_source ON tenant_groups(source_type);
CREATE INDEX IF NOT EXISTS idx_tenant_group_assignments_location_source ON tenant_group_assignments(location_id, source_type);
CREATE INDEX IF NOT EXISTS idx_tenant_group_assignments_group ON tenant_group_assignments(group_id);

-- Phase 1: multi-gateway infrastructure (backward compatible)
CREATE TABLE IF NOT EXISTS tenant_gateways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id TEXT NOT NULL,
    gateway_type TEXT NOT NULL CHECK (gateway_type IN ('recurrente', 'cybersource')),
    mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
    is_active INTEGER NOT NULL DEFAULT 0,
    config_test TEXT NOT NULL DEFAULT '{}',
    config_live TEXT NOT NULL DEFAULT '{}',
    display_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(location_id, gateway_type)
);

CREATE INDEX IF NOT EXISTS idx_tenant_gateways_location ON tenant_gateways(location_id);
CREATE INDEX IF NOT EXISTS idx_tenant_gateways_location_active ON tenant_gateways(location_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tenant_gateways_type ON tenant_gateways(gateway_type);

-- Transparent migration from legacy tenants -> recurrente gateway
INSERT INTO tenant_gateways (
    location_id,
    gateway_type,
    mode,
    is_active,
    config_test,
    config_live,
    display_name
)
SELECT
    t.location_id,
    'recurrente',
    COALESCE(NULLIF(t.mode, ''), 'test'),
    CASE WHEN t.is_active = 1 THEN 1 ELSE 0 END,
    json_object(
        'publicKey', COALESCE(t.recurrente_public_key, ''),
        'secretKey', COALESCE(t.recurrente_secret_key, '')
    ),
    json_object(
        'publicKey', COALESCE(t.recurrente_public_key_live, ''),
        'secretKey', COALESCE(t.recurrente_secret_key_live, '')
    ),
    COALESCE(t.business_name, '')
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1
    FROM tenant_gateways g
    WHERE g.location_id = t.location_id
      AND g.gateway_type = 'recurrente'
);
