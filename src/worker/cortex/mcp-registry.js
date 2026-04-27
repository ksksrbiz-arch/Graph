// MCP server registry — adds/removes/lists external MCP servers per user,
// caches their tool catalogs in D1, and dispatches tool calls. This is what
// makes Layer 10 work: any URL that speaks Streamable-HTTP MCP becomes a
// pluggable extension of the cortex tool registry, no Worker code change.
//
// Tools surfaced into the cortex registry are namespaced `mcp:<server>:<tool>`
// so the reasoner sees them alongside built-in tools but the dispatcher
// always knows where to route the call.

import { openSession, listTools as mcpListTools, callTool as mcpCallTool } from './mcp-client.js';

const TOOL_PREFIX = 'mcp:';

// ── server CRUD ──────────────────────────────────────────────────────

export async function addServer(env, { userId, name, url, authToken }) {
  if (!env.GRAPH_DB) throw new Error('GRAPH_DB binding missing');
  if (!name || !url) throw new Error('name and url are required');
  const id = crypto.randomUUID();
  await env.GRAPH_DB
    .prepare(
      `INSERT INTO mcp_servers (id, user_id, name, url, auth_token, enabled, created_at, tools_json)
       VALUES (?, ?, ?, ?, ?, 1, ?, '[]')`,
    )
    .bind(id, userId, normName(name), url.trim(), authToken || null, Date.now())
    .run();
  // First refresh — populate tool catalog right away so /tools shows them.
  const refresh = await refreshTools(env, { userId, serverId: id });
  return { id, name: normName(name), url, refresh };
}

export async function listServers(env, { userId, includeTools = false } = {}) {
  if (!env.GRAPH_DB) return [];
  const cols = 'id, name, url, enabled, created_at, last_listed_at, last_error, protocol_version, server_info_json'
             + (includeTools ? ', tools_json' : '');
  const { results } = await env.GRAPH_DB
    .prepare(`SELECT ${cols} FROM mcp_servers WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all();
  return (results || []).map((r) => ({
    id: r.id, name: r.name, url: r.url,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastListedAt: r.last_listed_at,
    lastError: r.last_error,
    protocolVersion: r.protocol_version,
    serverInfo: parseJsonSafe(r.server_info_json),
    tools: includeTools ? parseJsonSafe(r.tools_json, []) : undefined,
  }));
}

export async function removeServer(env, { userId, serverId }) {
  if (!env.GRAPH_DB) return false;
  const r = await env.GRAPH_DB
    .prepare(`DELETE FROM mcp_servers WHERE user_id = ? AND id = ?`)
    .bind(userId, serverId)
    .run();
  return (r.meta?.changes || 0) > 0;
}

export async function setEnabled(env, { userId, serverId, enabled }) {
  if (!env.GRAPH_DB) return false;
  await env.GRAPH_DB
    .prepare(`UPDATE mcp_servers SET enabled = ? WHERE user_id = ? AND id = ?`)
    .bind(enabled ? 1 : 0, userId, serverId)
    .run();
  return true;
}

// ── discovery ────────────────────────────────────────────────────────

/**
 * Re-fetch the tool catalog for one server (or all enabled servers if
 * serverId is omitted) and persist it. Cheap to call; we cache the JSON.
 */
export async function refreshTools(env, { userId, serverId }) {
  const servers = await loadServers(env, { userId, serverId });
  const out = [];
  for (const s of servers) {
    if (!s.enabled) continue;
    try {
      const sess = await openSession(s.url, { authToken: s.authToken });
      if (!sess.ok) {
        await markError(env, s.id, sess.error);
        out.push({ id: s.id, name: s.name, ok: false, error: sess.error });
        continue;
      }
      const lt = await sess.listTools();
      if (!lt.ok) {
        await markError(env, s.id, lt.error);
        out.push({ id: s.id, name: s.name, ok: false, error: lt.error });
        continue;
      }
      const tools = (lt.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || null,
      }));
      await env.GRAPH_DB
        .prepare(
          `UPDATE mcp_servers
             SET tools_json = ?, last_listed_at = ?, last_error = NULL,
                 protocol_version = ?, server_info_json = ?
           WHERE id = ?`,
        )
        .bind(
          JSON.stringify(tools),
          Date.now(),
          sess.protocolVersion || null,
          sess.serverInfo ? JSON.stringify(sess.serverInfo) : null,
          s.id,
        )
        .run();
      out.push({ id: s.id, name: s.name, ok: true, count: tools.length });
    } catch (err) {
      await markError(env, s.id, err.message);
      out.push({ id: s.id, name: s.name, ok: false, error: err.message });
    }
  }
  return out;
}

/**
 * Return MCP-discovered tools formatted for the cortex tool registry. The
 * `intent` is namespaced `mcp:<server>:<tool>` so the dispatcher can route
 * back to the right server, and the description carries the server name so
 * the reasoner has context.
 */
export async function describeMcpTools(env, { userId }) {
  const servers = await listServers(env, { userId, includeTools: true });
  const out = [];
  for (const s of servers) {
    if (!s.enabled || !Array.isArray(s.tools)) continue;
    for (const t of s.tools) {
      out.push({
        intent: `${TOOL_PREFIX}${s.name}:${t.name}`,
        description: `[mcp/${s.name}] ${t.description || t.name} — input schema fields: ${describeSchema(t.inputSchema)}`,
        // Carry inputSchema so the SPA can render arg forms if it wants.
        inputSchema: t.inputSchema,
      });
    }
  }
  return out;
}

/**
 * Dispatch an MCP tool by intent. Returns the same shape built-in tools do:
 * { ok, result?, error? }
 */
export async function dispatchMcpTool(env, intent, args, { userId }) {
  if (!intent.startsWith(TOOL_PREFIX)) return { ok: false, error: 'not an mcp intent' };
  const rest = intent.slice(TOOL_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return { ok: false, error: 'mcp intent must be mcp:<server>:<tool>' };
  const serverName = rest.slice(0, colon);
  const toolName   = rest.slice(colon + 1);

  const servers = await loadServers(env, { userId });
  const server = servers.find((s) => s.name === serverName && s.enabled);
  if (!server) return { ok: false, error: `mcp server "${serverName}" not registered or disabled` };

  try {
    const sess = await openSession(server.url, { authToken: server.authToken });
    if (!sess.ok) return { ok: false, error: sess.error };
    const r = await sess.callTool(toolName, args || {});
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      result: {
        text: r.text,
        structured: r.structured,
        contentBlocks: r.content?.length || 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── helpers ──────────────────────────────────────────────────────────

async function loadServers(env, { userId, serverId } = {}) {
  if (!env.GRAPH_DB) return [];
  const sql = serverId
    ? 'SELECT id, name, url, auth_token, enabled FROM mcp_servers WHERE user_id = ? AND id = ?'
    : 'SELECT id, name, url, auth_token, enabled FROM mcp_servers WHERE user_id = ?';
  const params = serverId ? [userId, serverId] : [userId];
  const { results } = await env.GRAPH_DB.prepare(sql).bind(...params).all();
  return (results || []).map((r) => ({
    id: r.id, name: r.name, url: r.url,
    authToken: r.auth_token,
    enabled: r.enabled === 1,
  }));
}

async function markError(env, serverId, error) {
  await env.GRAPH_DB
    .prepare(`UPDATE mcp_servers SET last_error = ?, last_listed_at = ? WHERE id = ?`)
    .bind(String(error || '').slice(0, 500), Date.now(), serverId)
    .run();
}

function describeSchema(schema) {
  if (!schema || typeof schema !== 'object') return '(none)';
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const items = Object.entries(props).slice(0, 8).map(([k, v]) => {
    const t = (v && v.type) || 'any';
    const r = required.has(k) ? '*' : '';
    return `${k}${r}:${t}`;
  });
  return items.length ? items.join(',') : '(empty)';
}

function parseJsonSafe(s, dflt = null) {
  if (!s) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
}

function normName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
}
