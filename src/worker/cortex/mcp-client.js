// Minimal MCP HTTP client. Speaks the JSON-RPC subset of MCP's Streamable
// HTTP transport that we need to:
//
//   1. initialize(serverUrl) → grab serverInfo + Mcp-Session-Id
//   2. listTools(serverUrl, sessionId) → array of {name, description, inputSchema}
//   3. callTool(serverUrl, sessionId, name, args) → {content, isError}
//
// We intentionally don't keep persistent SSE streams open — for cortex use
// the request/response flow is enough. Every tool call mints a fresh session
// (which is idempotent on most servers) so we don't have to track state
// across invocations of the cortex Worker.

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 12_000;
const CLIENT_INFO = { name: 'pkg-cortex', version: '1.0.0' };

/**
 * Single short-lived MCP session against `url`. Returns helpers bound to
 * the session id. Caller closes — but since we don't persist SSE, "close"
 * is just letting the helpers fall out of scope.
 */
export async function openSession(url, { authToken } = {}) {
  // 1) initialize
  const init = await rpc(url, {
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  }, { authToken });
  if (!init.ok) return { ok: false, error: init.error };

  const sessionId = init.sessionId; // captured from Mcp-Session-Id header
  const serverInfo = init.body?.result?.serverInfo;
  const protocolVersion = init.body?.result?.protocolVersion;

  // 2) notifications/initialized — must be sent after initialize per spec.
  //    Notification = no id, no response expected. We swallow errors here
  //    because some lighter servers ignore notifications entirely.
  try {
    await rpc(url, { method: 'notifications/initialized' }, {
      authToken, sessionId, isNotification: true,
    });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    sessionId,
    serverInfo,
    protocolVersion,
    listTools: () => listTools(url, { authToken, sessionId }),
    callTool: (name, args) => callTool(url, name, args, { authToken, sessionId }),
  };
}

export async function listTools(url, { authToken, sessionId } = {}) {
  const r = await rpc(url, {
    method: 'tools/list',
    params: {},
  }, { authToken, sessionId });
  if (!r.ok) return { ok: false, error: r.error, tools: [] };
  const tools = r.body?.result?.tools || [];
  return { ok: true, tools, sessionId: r.sessionId || sessionId };
}

export async function callTool(url, name, args, { authToken, sessionId } = {}) {
  const r = await rpc(url, {
    method: 'tools/call',
    params: { name, arguments: args || {} },
  }, { authToken, sessionId });
  if (!r.ok) return { ok: false, error: r.error };
  const result = r.body?.result;
  if (!result) {
    const err = r.body?.error;
    return { ok: false, error: err ? `${err.code}: ${err.message}` : 'no result' };
  }
  if (result.isError) {
    const txt = (result.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text).join('\n');
    return { ok: false, error: txt || 'tool reported isError without text' };
  }
  // Flatten content blocks down to a single text payload + raw blocks.
  const text = (result.content || [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text).join('\n');
  return { ok: true, text, content: result.content || [], structured: result.structuredContent };
}

// ── transport ────────────────────────────────────────────────────────

let nextRpcId = 1;

async function rpc(url, message, { authToken, sessionId, isNotification } = {}) {
  const headers = {
    'content-type': 'application/json',
    // The spec says clients SHOULD accept BOTH JSON and SSE. We accept both
    // so the server can pick — most one-shot servers reply JSON; SSE-first
    // servers will send `event: message\ndata: <json>\n\n`.
    'accept': 'application/json, text/event-stream',
  };
  if (sessionId)  headers['mcp-session-id'] = sessionId;
  if (authToken)  headers['authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;

  const body = isNotification
    ? { jsonrpc: '2.0', ...message }
    : { jsonrpc: '2.0', id: nextRpcId++, ...message };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: `fetch failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok && res.status !== 202) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }

  // Notifications get HTTP 202 with no body.
  if (isNotification) return { ok: true, body: null, sessionId: res.headers.get('mcp-session-id') };

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const newSession = res.headers.get('mcp-session-id') || sessionId;
  let parsed;
  try {
    if (ct.includes('text/event-stream')) {
      // Drain the SSE stream and grab the first JSON-RPC message frame.
      parsed = await readFirstSseJson(res);
    } else {
      parsed = await res.json();
    }
  } catch (err) {
    return { ok: false, error: `parse failed: ${err.message}` };
  }
  return { ok: true, body: parsed, sessionId: newSession };
}

async function readFirstSseJson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Look for a complete event (terminated by blank line)
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length) {
        try {
          return JSON.parse(dataLines.join(''));
        } catch { /* keep reading */ }
      }
    }
  }
  // Stream ended; try whatever's in the buffer.
  const dataLines = buf
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (dataLines.length) return JSON.parse(dataLines.join(''));
  throw new Error('SSE stream produced no JSON frame');
}
