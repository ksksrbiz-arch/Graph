// GitHub OAuth routes for the Cloudflare Worker.
//
// Implements the same four endpoints that scripts/serve.mjs exposes so the
// SPA's "Connect GitHub" button works when the app is deployed on Workers:
//
//   GET    /api/oauth/github/start     — build authorize URL, redirect to GitHub
//   GET    /api/oauth/github/callback  — exchange code for token, store in KV
//   GET    /api/oauth/github/status    — { connected: bool }
//   DELETE /api/oauth/github/status    — clear stored token
//
// Storage (both keys live in the GRAPH_KV binding):
//   oauth:state:<nonce>   — short-lived CSRF state (10-minute KV TTL)
//   oauth:github:token    — the stored access token (no expiry — GH tokens are
//                           long-lived until the user revokes them)
//
// Required Worker secrets (set via `wrangler secret put`):
//   GITHUB_CLIENT_ID
//   GITHUB_CLIENT_SECRET

const STATE_TTL_SECONDS = 600; // 10 minutes
const GITHUB_TOKEN_KV_KEY = 'oauth:github:token';
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_SCOPES = 'repo,read:user';

export async function handleOAuthApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/oauth/github/start' && method === 'GET') {
    return handleStart(request, env, url);
  }

  if (pathname === '/api/oauth/github/callback' && method === 'GET') {
    return handleCallback(request, env, url);
  }

  if (pathname === '/api/oauth/github/status') {
    if (method === 'GET') return handleStatus(env);
    if (method === 'DELETE') return handleDisconnect(env);
  }

  return null;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleStart(request, env, url) {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return htmlResponse(
      '<h2>GITHUB_CLIENT_ID secret not configured on this Worker.</h2>' +
      '<p>Run <code>wrangler secret put GITHUB_CLIENT_ID</code> and redeploy.</p>',
    );
  }

  if (!env.GRAPH_KV) {
    return htmlResponse('<h2>GRAPH_KV binding not available.</h2>');
  }

  const nonce = generateNonce();
  // Store the state nonce with a TTL so stale entries self-clean.
  await env.GRAPH_KV.put(
    `oauth:state:${nonce}`,
    JSON.stringify({ createdAt: Date.now() }),
    { expirationTtl: STATE_TTL_SECONDS },
  );

  const callbackUri = `${url.origin}/api/oauth/github/callback`;
  const authorizeUrl =
    `${GITHUB_AUTHORIZE_URL}` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(GITHUB_SCOPES)}` +
    `&state=${nonce}` +
    `&redirect_uri=${encodeURIComponent(callbackUri)}`;

  return Response.redirect(authorizeUrl, 302);
}

async function handleCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    const desc = url.searchParams.get('error_description') || error;
    return htmlResponse(`<script>window.close();</script><p>OAuth error: ${escapeHtml(desc)}</p>`);
  }

  if (!code || !state) {
    return htmlResponse('<script>window.close();</script><p>Missing code or state.</p>');
  }

  if (!env.GRAPH_KV) {
    return htmlResponse('<script>window.close();</script><p>GRAPH_KV binding not available.</p>');
  }

  // Validate and consume the state nonce (CSRF protection).
  const stateKey = `oauth:state:${state}`;
  const stateEntry = await env.GRAPH_KV.get(stateKey, 'json');
  if (!stateEntry) {
    return htmlResponse('<script>window.close();</script><p>Invalid or expired OAuth state. Please try again.</p>');
  }
  await env.GRAPH_KV.delete(stateKey);

  const clientId     = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return htmlResponse(
      '<script>window.close();</script>' +
      '<p>GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET secrets not configured on this Worker.</p>',
    );
  }

  let tokenBody;
  try {
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    tokenBody = await tokenRes.json();
  } catch (err) {
    return htmlResponse(`<script>window.close();</script><p>Token exchange error: ${escapeHtml(err.message)}</p>`);
  }

  if (!tokenBody?.access_token) {
    const msg = tokenBody?.error_description || tokenBody?.error || 'unknown error';
    return htmlResponse(`<script>window.close();</script><p>OAuth failed: ${escapeHtml(msg)}</p>`);
  }

  await env.GRAPH_KV.put(GITHUB_TOKEN_KV_KEY, tokenBody.access_token);

  return htmlResponse(connectedPage());
}

async function handleStatus(env) {
  if (!env.GRAPH_KV) {
    return jsonResponse({ connected: false });
  }
  const token = await env.GRAPH_KV.get(GITHUB_TOKEN_KV_KEY);
  return jsonResponse({ connected: token !== null });
}

async function handleDisconnect(env) {
  if (env.GRAPH_KV) {
    await env.GRAPH_KV.delete(GITHUB_TOKEN_KV_KEY);
  }
  return jsonResponse({ connected: false });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Cryptographically random hex nonce (128 bits). */
function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;',
  );
}

function connectedPage() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<title>Connected</title>
<body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center">
    <h2 style="color:#5fd0a4">&#x2713; GitHub Connected</h2>
    <p>You can close this window.</p>
  </div>
  <script>setTimeout(function(){window.close();},1500);</script>
</body>
</html>`;
}
