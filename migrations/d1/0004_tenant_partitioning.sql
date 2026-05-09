-- Tenant partitioning rollout scaffold.
-- Migration-first phase: preserve existing user_id semantics while adding
-- tenant_id columns, backfilling them from user_id, and adding tenant indexes.

ALTER TABLE sources ADD COLUMN tenant_id TEXT;
UPDATE sources SET tenant_id = user_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_sources_tenant ON sources(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_tenant_kind_label ON sources(tenant_id, kind, label);

ALTER TABLE events ADD COLUMN tenant_id TEXT;
UPDATE events SET tenant_id = user_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_tenant_ts ON events(tenant_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tenant_payload_sha ON events(tenant_id, payload_sha);

ALTER TABLE nodes ADD COLUMN tenant_id TEXT;
UPDATE nodes SET tenant_id = user_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_tenant_type ON nodes(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_tenant_seen ON nodes(tenant_id, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_tenant_id ON nodes(tenant_id, id);

ALTER TABLE edges ADD COLUMN tenant_id TEXT;
UPDATE edges SET tenant_id = user_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_edges_tenant_pre ON edges(tenant_id, pre);
CREATE INDEX IF NOT EXISTS idx_edges_tenant_post ON edges(tenant_id, post);
CREATE INDEX IF NOT EXISTS idx_edges_tenant_type ON edges(tenant_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_tenant_id ON edges(tenant_id, id);

ALTER TABLE mcp_servers ADD COLUMN tenant_id TEXT;
UPDATE mcp_servers SET tenant_id = user_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant ON mcp_servers(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_tenant_name ON mcp_servers(tenant_id, name);
