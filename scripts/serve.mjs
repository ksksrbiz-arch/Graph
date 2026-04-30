import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.scss': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const INGESTERS = {
  'claude-code':    'scripts/ingest-claude-code.mjs',
  'git':            'scripts/ingest-git.mjs',
  'markdown':       'scripts/ingest-markdown.mjs',
  'zotero':         'scripts/ingest-zotero.mjs',
  'webclip':        'scripts/ingest-webclip.mjs',
  'evernote':       'scripts/ingest-evernote.mjs',
  'daily-note':     'scripts/ingest-daily-note.mjs',
  'github':         'scripts/ingest-github.mjs',
  'bookmarks':      'scripts/ingest-bookmarks.mjs',
  'claude-export':  'scripts/ingest-claude-export.mjs',
};

/** Slugs that are currently executing — prevents duplicate concurrent runs. */
const runningIngesters = new Set();

/** In-memory GitHub OAuth token (per server process). */
let githubToken = null;

/** Pending OAuth state tokens: state → { createdAt }. */
const pendingOAuthStates = new Map();

/** Stale OAuth states are pruned after this many milliseconds (10 minutes). */
const OAUTH_STATE_TIMEOUT_MS = 600_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonRes(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function htmlRes(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ── Ingester runner ───────────────────────────────────────────────────────────

function runIngester(slug, envOverrides = {}) {
  return new Promise((resolveP) => {
    const script = INGESTERS[slug];
    if (!script) {
      resolveP({ code: 404, stdout: '', stderr: `unknown ingester: ${slug}` });
      return;
    }
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolveP({ code: 500, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });
}

async function handleIngestPost(slug, req, res) {
  if (!INGESTERS[slug]) {
    jsonRes(res, 404, { ok: false, error: `unknown ingester: ${slug}` });
    return;
  }

  // Idempotency: reject duplicate concurrent runs of the same slug.
  if (runningIngesters.has(slug)) {
    jsonRes(res, 409, { ok: false, error: `${slug} is already running — wait for it to complete` });
    return;
  }

  const rawBody = await readBody(req);
  let body = {};
  if (rawBody.length) {
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* ignore */ }
  }

  const envOverrides = typeof body.env === 'object' && body.env ? { ...body.env } : {};

  // Handle optional file upload: { file: { name, content (base64), field } }
  let tmpDir = null;
  if (body.file?.content && body.file?.field) {
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'graph-ingest-'));
      const rawName = String(body.file.name || 'upload');
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
      const tmpPath = join(tmpDir, safeName);
      await writeFile(tmpPath, Buffer.from(String(body.file.content), 'base64'));
      envOverrides[String(body.file.field)] = tmpPath;
    } catch (err) {
      jsonRes(res, 400, { ok: false, error: `file upload failed: ${err.message}` });
      return;
    }
  }

  runningIngesters.add(slug);
  let result;
  try {
    result = await runIngester(slug, envOverrides);
  } finally {
    runningIngesters.delete(slug);
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const status = result.code === 0 ? 200 : (result.code === 404 ? 404 : 500);
  jsonRes(res, status, { ok: result.code === 0, ...result });
}

// ── GitHub OAuth ──────────────────────────────────────────────────────────────

function handleGitHubOAuthStart(req, res) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    htmlRes(res, '<h2>GITHUB_CLIENT_ID env var not set.</h2><p>Add it to your environment and restart the server.</p>');
    return;
  }
  const state = randomBytes(16).toString('hex');
  pendingOAuthStates.set(state, { createdAt: Date.now() });
  // Prune stale states (> 10 min)
  for (const [k, v] of pendingOAuthStates) {
    if (Date.now() - v.createdAt > OAUTH_STATE_TIMEOUT_MS) pendingOAuthStates.delete(k);
  }
  const redirectUri = `http://localhost:${PORT}/api/oauth/github/callback`;
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=repo%2Cread%3Auser&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.writeHead(302, { location: url });
  res.end();
}

async function handleGitHubOAuthCallback(searchParams, res) {
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  if (!code || !state || !pendingOAuthStates.has(state)) {
    htmlRes(res, '<script>window.close();</script><p>Invalid OAuth state. Please try again.</p>');
    return;
  }
  pendingOAuthStates.delete(state);

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    htmlRes(res, '<script>window.close();</script><p>GITHUB_CLIENT_SECRET not configured on the server.</p>');
    return;
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenBody = await tokenRes.json();
    if (tokenBody.access_token) {
      githubToken = tokenBody.access_token;
      htmlRes(res, `<!doctype html><html><head><title>Connected</title></head><body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><h2 style="color:#5fd0a4">✓ GitHub Connected</h2><p>You can close this window.</p></div><script>setTimeout(()=>window.close(),1500);</script></body></html>`);
    } else {
      htmlRes(res, `<script>window.close();</script><p>OAuth failed: ${tokenBody.error_description || tokenBody.error || 'unknown'}</p>`);
    }
  } catch (err) {
    htmlRes(res, `<script>window.close();</script><p>OAuth error: ${err.message}</p>`);
  }
}

// ── Static file serving ───────────────────────────────────────────────────────

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^\/+/, '');
  const abs = resolve(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

async function resolveStaticPath(urlPath) {
  if (urlPath === '/' || urlPath === '') return join(ROOT, 'web', 'index.html');
  const direct = safeJoin(urlPath);
  if (!direct) return null;
  try {
    const s = await stat(direct);
    if (s.isFile()) return direct;
    if (s.isDirectory()) {
      const idx = join(direct, 'index.html');
      try { if ((await stat(idx)).isFile()) return idx; } catch {}
    }
  } catch {}
  const inWeb = safeJoin(`/web${urlPath}`);
  if (inWeb) {
    try { if ((await stat(inWeb)).isFile()) return inWeb; } catch {}
  }
  return null;
}


const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'content-type' });
      res.end();
      return;
    }

    // Health
    if (url.pathname === '/api/ingest/health' && req.method === 'GET') {
      jsonRes(res, 200, { ok: true, ingesters: Object.keys(INGESTERS), running: [...runningIngesters] });
      return;
    }

    // Run ingest
    if (url.pathname.startsWith('/api/ingest/') && req.method === 'POST') {
      const slug = url.pathname.slice('/api/ingest/'.length);
      await handleIngestPost(slug, req, res);
      return;
    }

    // GitHub OAuth: start flow
    if (url.pathname === '/api/oauth/github/start' && req.method === 'GET') {
      handleGitHubOAuthStart(req, res);
      return;
    }

    // GitHub OAuth: callback from GitHub
    if (url.pathname === '/api/oauth/github/callback' && req.method === 'GET') {
      await handleGitHubOAuthCallback(url.searchParams, res);
      return;
    }

    // GitHub OAuth: status / disconnect
    if (url.pathname === '/api/oauth/github/status') {
      if (req.method === 'GET') {
        jsonRes(res, 200, { connected: githubToken !== null });
        return;
      }
      if (req.method === 'DELETE') {
        githubToken = null;
        jsonRes(res, 200, { connected: false });
        return;
      }
    }

    // Static files
    const path = await resolveStaticPath(url.pathname);
    if (!path) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const fileBody = await readFile(path);
    const type = MIME[extname(path)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(fileBody);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Graph dev server running at http://localhost:${PORT}`);
  console.log(`Serving from ${ROOT}`);
});
