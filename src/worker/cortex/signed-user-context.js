const S2S_MAX_SKEW_MS = 5 * 60_000;

export async function verifySignedUserContext(request, env, expectedUserId) {
  const secret = (env.CORTEX_S2S_SECRET || '').toString();
  if (!secret) return false;
  const userId = (request.headers.get('x-cortex-user') || '').trim();
  const tsRaw = (request.headers.get('x-cortex-ts') || '').trim();
  const sig = (request.headers.get('x-cortex-signature') || '').trim();
  if (!userId || !tsRaw || !sig || userId !== expectedUserId) return false;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > S2S_MAX_SKEW_MS) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = `${userId}.${tsRaw}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = toHex(new Uint8Array(mac));
  return timingSafeEqualHex(expected, sig.toLowerCase());
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
