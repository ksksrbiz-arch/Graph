-- Layer 10 — MCP plugin layer storage. Apply with:
--   wrangler d1 execute datab_1 --remote --file=migrations/d1/0002_mcp_servers.sql

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_token TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_listed_at INTEGER,
  last_error TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',
  protocol_version TEXT,
  server_info_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_user_name ON mcp_servers(user_id, name);
