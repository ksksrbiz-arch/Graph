-- Initial D1 schema for graph-snapshots ingest pipeline.
-- Apply with:
--   wrangler d1 execute datab_1 --remote --file=migrations/d1/0001_init.sql

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  webhook_secret TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id);
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  source_id TEXT,
  source_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_sha TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'applied',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_payload_sha ON events(user_id, payload_sha);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_user_type ON nodes(user_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_user_seen ON nodes(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pre TEXT NOT NULL,
  post TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  source_kind TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_edges_user_pre ON edges(user_id, pre);
CREATE INDEX IF NOT EXISTS idx_edges_user_post ON edges(user_id, post);
CREATE INDEX IF NOT EXISTS idx_edges_user_type ON edges(user_id, type);
