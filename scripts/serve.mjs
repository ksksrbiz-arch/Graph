import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const ROOT = resolve(new URL('..', import.meta.url).pathname);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^\/+/, '');
  const abs = resolve(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

async function resolvePath(urlPath) {
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
    try {
      const s = await stat(inWeb);
      if (s.isFile()) return inWeb;
    } catch {}
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const path = await resolvePath(req.url || '/');
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
