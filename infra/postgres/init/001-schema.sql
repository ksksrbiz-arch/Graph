-- PKG-VS bootstrap schema. Loaded automatically by the postgres container
-- (docker-entrypoint-initdb.d). Re-runs are skipped when the volume exists.
-- Production migrations live in apps/api/src/migrations/.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ── users ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT,                     -- nullable: oauth-only users
  display_name    TEXT,
  locale          TEXT NOT NULL DEFAULT 'en',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ── connector_configs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_configs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id             TEXT NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT false,
  -- AES-256-GCM blob: { ciphertext, iv, keyId } — see ADR-006.
  credentials              JSONB,
  sync_interval_minutes    INTEGER NOT NULL DEFAULT 60,
  last_sync_at             TIMESTAMPTZ,
  last_sync_status         TEXT CHECK (last_sync_status IN ('success','partial','failed')),
  rate_limit_remaining     INTEGER,
  rate_limit_resets_at     TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, connector_id)
);

-- ── audit_events (append-only — see Rule 18) ─────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  metadata    JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Block UPDATE / DELETE on audit_events (immutable log).
-- Rules emit a no-op-ish error so attempts to mutate the audit log fail loudly.
DO $$ BEGIN
  CREATE OR REPLACE RULE audit_events_no_update AS
    ON UPDATE TO audit_events DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE OR REPLACE RULE audit_events_no_delete AS
    ON DELETE TO audit_events DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS audit_events_user_idx
  ON audit_events (user_id, created_at DESC);

-- ── consents (GDPR) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_kind TEXT NOT NULL,
  granted     BOOLEAN NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── refresh_tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ── agent_permission_grants ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_permission_grants (
  user_id     TEXT NOT NULL,
  scope       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
CREATE INDEX IF NOT EXISTS agent_permission_grants_user_idx
  ON agent_permission_grants (user_id, granted_at DESC);

-- ── pending_motor_actions (human-in-the-loop approval queue) ────────
-- Motor intents that the safety supervisor routes to 'requires-approval'
-- land here pending an explicit human approve/reject decision.
-- user_id / decided_by are TEXT (not a users FK) to match the JwtAuthGuard
-- Phase-0 anon-mode subject (default 'local'), exactly like
-- agent_permission_grants above.
CREATE TABLE IF NOT EXISTS pending_motor_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  action       TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  neuron_id    TEXT,
  confidence   DOUBLE PRECISION NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  decided_by   TEXT,
  decision_note TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pending_motor_actions_pending_idx
  ON pending_motor_actions (user_id, created_at DESC) WHERE status = 'pending';
