const DEFAULT_SERVICE_ISSUER = 'graph-worker';
const DEFAULT_SERVICE_AUDIENCE = 'graph-api-brain';
const DEFAULT_TIMEOUT_MS = 5_000;

export async function getContextPackage(env, authContext, input = {}) {
  return callInternalBrain(env, authContext, '/brain/internal/context-package', input);
}

export async function publishObservation(env, authContext, observation) {
  return callInternalBrain(env, authContext, '/brain/internal/observations', observation);
}

export async function getNeuralState(env, authContext) {
  return callInternalBrain(env, authContext, '/brain/internal/neural-state', {});
}

async function callInternalBrain(env, authContext, path, body) {
  if (!env.NEST_API_URL && !env.INTERNAL_BRAIN_BASE_URL) {
    return { ok: false, skipped: true, error: 'internal brain base URL is not configured' };
  }
  const base = (env.INTERNAL_BRAIN_BASE_URL || env.NEST_API_URL).replace(/\/+$/, '');
  const token = await signServiceJwt(env, authContext);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.INTERNAL_BRAIN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-correlation-id': authContext.correlationId || crypto.randomUUID(),
        'x-tenant-id': authContext.tenantId,
      },
      body: JSON.stringify({ ...body, tenantId: authContext.tenantId, userId: authContext.userId }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return res.ok ? { ok: true, data } : { ok: false, status: res.status, error: data?.error || text || res.statusText };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function signServiceJwt(env, authContext) {
  const secret = env.WORKER_SERVICE_JWT_SECRET || env.INTERNAL_SERVICE_JWT_SECRET || env.JWT_SECRET;
  if (!secret) throw new Error('service JWT secret is not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: authContext.userId,
    tenantId: authContext.tenantId,
    roles: authContext.roles || [],
    iss: env.WORKER_SERVICE_JWT_ISSUER || DEFAULT_SERVICE_ISSUER,
    aud: env.WORKER_SERVICE_JWT_AUDIENCE || DEFAULT_SERVICE_AUDIENCE,
    iat: now,
    exp: now + Number(env.WORKER_SERVICE_JWT_TTL_SECONDS || 60),
  };
  return signHs256(payload, secret);
}

async function signHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64Url(new Uint8Array(sig))}`;
}

function base64Url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
