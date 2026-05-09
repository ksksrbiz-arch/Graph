// MCP server registry — adds/removes/lists external MCP servers per user,
// caches their tool catalogs in D1, and dispatches tool calls. This is what
// makes Layer 10 work: any URL that speaks Streamable-HTTP MCP becomes a
// pluggable extension of the cortex tool registry, no Worker code change.
//
// Tools surfaced into the cortex registry are namespaced `mcp:<server>:<tool>`
// so the reasoner sees them alongside built-in tools but the dispatcher
// always knows where to route the call.

import { openSession, listTools as mcpListTools, callTool as mcpCallTool } from './mcp-client.js';
import { handleMcpServer } from '../mcp-server.js';

async function inprocessMcp(env, body) {
  // Build a synthetic Request and call our own MCP server handler. This is
  // how the worker uses ITS OWN /mcp without hitting CF's subrequest loop.
  const url = new URL('https://internal/mcp');
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handleMcpServer(req, env, url);
  if (!res) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

function isSameHost(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === 'graph.skdev-371.workers.dev' ||
           u.hostname.endsWith('.workers.dev') ||
           u.hostname === 'localhost';
  } catch { return false; }
}

const TOOL_PREFIX = 'mcp:';
const AUTH_TOKEN_PREFIX = 'enc1:';
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_LIST_TIMEOUT_MS = 8_000;
const DEFAULT_CALL_TIMEOUT_MS = 12_000;

// ── server CRUD ──────────────────────────────────────────────────────

export async function addServer(env, { userId, name, url, authToken }) {
  if (!env.GRAPH_DB) throw new Error('GRAPH_DB binding missing');
  if (!name || !url) throw new Error('name and url are required');
  const id = crypto.randomUUID();
  const encryptedAuthToken = await encryptAuthToken(env, authToken || null);
  await env.GRAPH_DB
    .prepare(
      `INSERT INTO mcp_servers (id, user_id, name, url, auth_token, enabled, created_at, tools_json)
       VALUES (?, ?, ?, ?, ?, 1, ?, '[]')`,
    )
    .bind(id, userId, normName(name), url.trim(), encryptedAuthToken, Date.now())
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
  const timeoutMs = mcpListTimeoutMs(env);
  const attempts = mcpRetryAttempts(env);
  for (const s of servers) {
    if (!s.enabled) continue;
    try {
      let sess;
      if (isSameHost(s.url)) {
        // Skip HTTP — call ourselves in-process to avoid CF's loop guard.
        const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-loop', version: '1' } } };
        const init = await inprocessMcp(env, initBody);
        if (!init || init.error) { await markError(env, s.id, init?.error?.message || 'init failed'); out.push({ id: s.id, name: s.name, ok: false, error: init?.error?.message || 'init failed' }); continue; }
        const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
        const list = await inprocessMcp(env, listBody);
        if (!list || list.error) { await markError(env, s.id, list?.error?.message || 'list failed'); out.push({ id: s.id, name: s.name, ok: false, error: list?.error?.message || 'list failed' }); continue; }
        const tools = (list.result?.tools || []).map((t) => ({
          name: t.name, description: t.description || '', inputSchema: t.inputSchema || null,
        }));
        await env.GRAPH_DB.prepare(
          `UPDATE mcp_servers SET tools_json = ?, last_listed_at = ?, last_error = NULL,
                 protocol_version = ?, server_info_json = ? WHERE id = ?`
        ).bind(
          JSON.stringify(tools), Date.now(),
          init.result?.protocolVersion || null,
          init.result?.serverInfo ? JSON.stringify(init.result.serverInfo) : null,
          s.id,
        ).run();
        out.push({ id: s.id, name: s.name, ok: true, count: tools.length, transport: 'in-process' });
        continue;
      }
      sess = await withRetryResult(
        () => openSession(s.url, { authToken: s.authToken, timeoutMs }),
        attempts,
      );
      if (!sess.ok) {
        await markError(env, s.id, sess.error);
        out.push({ id: s.id, name: s.name, ok: false, error: sess.error });
        continue;
      }
      const lt = await withRetryResult(() => sess.listTools(), attempts);
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
    const timeoutMs = mcpCallTimeoutMs(env);
    const attempts = mcpRetryAttempts(env);
    if (isSameHost(server.url)) {
      const callBody = { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args || {} } };
      const out = await withRetry(() => inprocessMcp(env, callBody), attempts);
      if (!out) return { ok: false, error: 'in-process MCP returned null' };
      if (out.error) return { ok: false, error: out.error.message || 'mcp error' };
      const result = out.result;
      if (result?.isError) {
        const txt = (result.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        return { ok: false, error: txt || 'tool reported isError' };
      }
      const text = (result?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
      return { ok: true, result: { text, structured: result?.structuredContent, contentBlocks: result?.content?.length || 0, transport: 'in-process' } };
    }
    const sess = await withRetryResult(
      () => openSession(server.url, { authToken: server.authToken, timeoutMs }),
      attempts,
    );
    if (!sess.ok) return { ok: false, error: sess.error };
    const r = await withRetryResult(() => sess.callTool(toolName, args || {}), attempts);
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
  const out = [];
  for (const r of results || []) {
    out.push({
      id: r.id,
      name: r.name,
      url: r.url,
      authToken: await decryptAuthToken(env, r.auth_token),
      enabled: r.enabled === 1,
    });
  }
  return out;
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

function mcpListTimeoutMs(env) {
  return clampInt(env?.MCP_LIST_TIMEOUT_MS, 1_000, 60_000, DEFAULT_LIST_TIMEOUT_MS);
}

function mcpCallTimeoutMs(env) {
  return clampInt(env?.MCP_CALL_TIMEOUT_MS, 1_000, 60_000, DEFAULT_CALL_TIMEOUT_MS);
}

function mcpRetryAttempts(env) {
  return clampInt(env?.MCP_RETRY_ATTEMPTS, 1, 4, DEFAULT_RETRY_ATTEMPTS);
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}

async function withRetry(fn, attempts) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function withRetryResult(fn, attempts) {
  return withRetry(async () => {
    const out = await fn();
    if (!out || out.ok === false) {
      throw new Error(out?.error || 'mcp call failed');
    }
    return out;
  }, attempts);
}

async function encryptAuthToken(env, token) {
  if (!token) return null;
  const key = await mcpTokenKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(String(token));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return AUTH_TOKEN_PREFIX + bytesToBase64(packed);
}

async function decryptAuthToken(env, encoded) {
  if (!encoded) return null;
  const raw = String(encoded);
  if (!raw.startsWith(AUTH_TOKEN_PREFIX)) return raw; // backward compatible plaintext
  const key = await mcpTokenKey(env);
  const bytes = base64ToBytes(raw.slice(AUTH_TOKEN_PREFIX.length));
  if (bytes.length < 13) throw new Error('invalid encrypted MCP auth token');
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

async function mcpTokenKey(env) {
  const b64 = (env?.MCP_TOKEN_KEK_BASE64 || '').toString().trim();
  if (!b64) {
    throw new Error('MCP_TOKEN_KEK_BASE64 is required for encrypting/decrypting MCP auth tokens');
  }
  const raw = base64ToBytes(b64);
  if (raw.byteLength !== 32) {
    throw new Error('MCP_TOKEN_KEK_BASE64 must decode to exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
