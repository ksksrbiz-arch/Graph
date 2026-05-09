const DEFAULT_JWT_ISSUER = 'graph-api';
const DEFAULT_JWT_AUDIENCE = 'graph-worker';

export async function requireAuthContext(request, env, { expectedUserId, expectedTenantId } = {}) {
  const bearer = readBearer(request);
  if (bearer) {
    const payload = await verifyJwt(bearer, env.WORKER_JWT_SECRET || env.JWT_SECRET, {
      issuer: env.JWT_ISSUER || DEFAULT_JWT_ISSUER,
      audience: env.JWT_AUDIENCE || DEFAULT_JWT_AUDIENCE,
    });
    const userId = stringClaim(payload.sub);
    const tenantId = stringClaim(payload.tenantId || payload.tid || payload.tenant_id || payload.sub);
    const roles = Array.isArray(payload.roles)
      ? payload.roles.map((r) => String(r)).filter(Boolean)
      : typeof payload.roles === 'string'
        ? payload.roles.split(',').map((r) => r.trim()).filter(Boolean)
        : [];
    if (!userId || !tenantId) throw new AuthError('JWT must include sub and tenantId claims', 401);
    assertMatches('userId', userId, expectedUserId);
    assertMatches('tenantId', tenantId, expectedTenantId);
    return { userId, tenantId, roles };
  }

  if (env.JWT_SECRET || env.WORKER_JWT_SECRET) {
    throw new AuthError('missing bearer token', 401);
  }

  const fallbackUserId = String(expectedUserId || 'local').trim();
  if (!checkLegacyUser(fallbackUserId, env)) {
    throw new AuthError(`userId=${fallbackUserId || '(empty)'} is not authorized`, 403);
  }
  return {
    userId: fallbackUserId,
    tenantId: String(expectedTenantId || fallbackUserId).trim(),
    roles: ['legacy'],
  };
}

export function authErrorResponse(err) {
  const status = err instanceof AuthError ? err.status : 401;
  return jsonResponse({ error: err.message || 'unauthorized' }, status);
}

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

async function verifyJwt(token, secret, { issuer, audience }) {
  if (!secret) throw new AuthError('JWT validation secret is not configured', 503);
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed bearer token', 401);
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtPart(encodedHeader);
  if (header.alg !== 'HS256') throw new AuthError('unsupported JWT alg', 401);
  const expected = await hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  if (!timingSafeEqual(base64UrlToBytes(encodedSignature), expected)) {
    throw new AuthError('bad JWT signature', 401);
  }
  const payload = parseJwtPart(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) < now - 30) throw new AuthError('expired JWT', 401);
  if (payload.nbf && Number(payload.nbf) > now + 30) throw new AuthError('JWT not yet valid', 401);
  if (issuer && payload.iss && payload.iss !== issuer) throw new AuthError('bad JWT issuer', 401);
  if (audience && payload.aud && payload.aud !== audience) throw new AuthError('bad JWT audience', 401);
  return payload;
}

function readBearer(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] || null;
}

function parseJwtPart(part) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
  } catch {
    throw new AuthError('malformed bearer token', 401);
  }
}

async function hmacSha256(input, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function stringClaim(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assertMatches(name, actual, expected) {
  if (!expected) return;
  if (String(expected).trim() !== actual) {
    throw new AuthError(`${name} claim mismatch`, 403);
  }
}

function checkLegacyUser(userId, env) {
  if (!userId || typeof userId !== 'string') return false;
  const csv = (env.PUBLIC_INGEST_USER_IDS || 'local').toString();
  return csv.split(',').map((s) => s.trim()).filter(Boolean).includes(userId.trim());
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
