-- Accounts Payable Cortex (APC) — Phase 1 schema.
-- Apply with:
--   wrangler d1 execute datab_1 --remote --file=migrations/d1/0003_finance.sql

-- ── Vendors ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apc_vendors (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ein TEXT,                        -- EIN / W-9 reference
  payment_terms INTEGER NOT NULL DEFAULT 30, -- net-N days
  early_pay_discount_pct REAL NOT NULL DEFAULT 0, -- e.g. 0.02 = 2 %
  early_pay_discount_days INTEGER NOT NULL DEFAULT 0,
  contact_email TEXT,
  contact_phone TEXT,
  address_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | inactive
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_apc_vendors_user ON apc_vendors(user_id);
CREATE INDEX IF NOT EXISTS idx_apc_vendors_name ON apc_vendors(user_id, name);

-- ── Bills / Invoices ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apc_bills (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vendor_id TEXT,                  -- FK → apc_vendors.id (nullable = unknown vendor)
  invoice_number TEXT,
  invoice_date INTEGER,            -- epoch ms
  due_date INTEGER,                -- epoch ms
  amount_cents INTEGER NOT NULL DEFAULT 0, -- total due in cents
  currency TEXT NOT NULL DEFAULT 'USD',
  tax_category TEXT,               -- WA_BO | WA_SALES_TAX | FEDERAL_1099 | NONE
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | paid | rejected | overdue
  risk_score REAL NOT NULL DEFAULT 0,     -- 0–1
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | vision | email | csv
  raw_text TEXT,                   -- original extracted text from invoice
  data_json TEXT NOT NULL DEFAULT '{}',   -- extra fields (line items, etc.)
  node_id TEXT,                    -- corresponding graph node id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_apc_bills_user_status ON apc_bills(user_id, status);
CREATE INDEX IF NOT EXISTS idx_apc_bills_user_due ON apc_bills(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_apc_bills_vendor ON apc_bills(user_id, vendor_id);

-- ── Payment Proposals ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apc_payment_proposals (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,           -- FK → apc_bills.id
  proposed_date INTEGER NOT NULL,  -- epoch ms — when to pay
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'ach', -- ach | check | wire | credit_card
  rationale TEXT,                  -- human-readable explanation from agent
  risk_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_apc_proposals_user_status ON apc_payment_proposals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_apc_proposals_bill ON apc_payment_proposals(user_id, bill_id);

-- ── Tax Liabilities ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apc_tax_liabilities (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tax_type TEXT NOT NULL,          -- WA_BO | WA_SALES_TAX | FEDERAL_1099 | FEDERAL_QUARTERLY
  period TEXT NOT NULL,            -- e.g. "2025-Q2" or "2025-10"
  estimated_cents INTEGER NOT NULL DEFAULT 0,
  filed_cents INTEGER,
  due_date INTEGER,                -- epoch ms
  status TEXT NOT NULL DEFAULT 'estimated', -- estimated | filed | paid | overdue
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apc_tax_user_type_period ON apc_tax_liabilities(user_id, tax_type, period);
CREATE INDEX IF NOT EXISTS idx_apc_tax_user_status ON apc_tax_liabilities(user_id, status);

-- ── Compliance Rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apc_compliance_rules (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,      -- WA | FEDERAL | BOTH
  description TEXT NOT NULL,
  effective_date INTEGER,
  source_url TEXT,
  active INTEGER NOT NULL DEFAULT 1, -- boolean
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_apc_rules_user ON apc_compliance_rules(user_id, active);

-- ── Approval Events (audit trail) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS apc_approval_events (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,       -- bill | payment_proposal | tax_liability
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- approved | rejected | edited | flagged
  actor TEXT NOT NULL DEFAULT 'user',
  notes TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_apc_approvals_user_ts ON apc_approval_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_apc_approvals_entity ON apc_approval_events(user_id, entity_type, entity_id);
