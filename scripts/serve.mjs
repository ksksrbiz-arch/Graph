import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  'claude-code': 'scripts/ingest-claude-code.mjs',
  'git': 'scripts/ingest-git.mjs',
  'markdown': 'scripts/ingest-markdown.mjs',
};

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

function runIngester(slug) {
  return new Promise((resolveP) => {
    const script = INGESTERS[slug];
    if (!script) {
      resolveP({ code: 404, stdout: '', stderr: `unknown ingester: ${slug}` });
      return;
    }
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolveP({ code: 500, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/ingest/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ingesters: Object.keys(INGESTERS) }));
      return;
    }
    if (url.pathname.startsWith('/api/ingest/') && req.method === 'POST') {
      const slug = url.pathname.slice('/api/ingest/'.length);
      const result = await runIngester(slug);
      const status = result.code === 0 ? 200 : (result.code === 404 ? 404 : 500);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: result.code === 0, ...result }));
      return;
    }

    const path = await resolveStaticPath(url.pathname);
    if (!path) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const body = await readFile(path);
    const type = MIME[extname(path)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Graph dev server running at http://localhost:${PORT}`);
  console.log(`Serving from ${ROOT}`);
});
