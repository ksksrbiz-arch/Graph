// Working memory — the cortex's "currently thinking about" buffer. Lives in
// KV under `attention:<userId>`. Read at the start of every think() cycle,
// written at the end. TTL ≈ 1 hour; refreshed on each interaction.
//
// Shape:
//   {
//     userId,
//     focus: string[],              // node ids currently in scope
//     recentEvents: string[],       // event ids the reasoner has seen
//     pendingIntents: ActMessage[], // tool calls queued for next cycle
//     lastUpdated: ms epoch
//   }

const ATTENTION_KEY = (userId) => `attention:${userId}`;
const ATTENTION_TTL_S = 60 * 60; // 1 hour
const MAX_FOCUS = 32;
const MAX_RECENT = 64;
const MAX_PENDING = 16;

export async function readAttention(kv, userId) {
  if (!kv) return empty(userId);
  const raw = await kv.get(ATTENTION_KEY(userId), 'json');
  if (!raw) return empty(userId);
  return {
    userId,
    focus: Array.isArray(raw.focus) ? raw.focus.slice(0, MAX_FOCUS) : [],
    recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents.slice(0, MAX_RECENT) : [],
    pendingIntents: Array.isArray(raw.pendingIntents) ? raw.pendingIntents.slice(0, MAX_PENDING) : [],
    lastUpdated: raw.lastUpdated || Date.now(),
  };
}

export async function writeAttention(kv, userId, patch) {
  if (!kv) return null;
  const current = await readAttention(kv, userId);
  const next = {
    userId,
    focus:          mergeUnique(current.focus,          patch.focus,          MAX_FOCUS),
    recentEvents:   mergeUnique(current.recentEvents,   patch.recentEvents,   MAX_RECENT),
    pendingIntents: replace(current.pendingIntents,     patch.pendingIntents, MAX_PENDING),
    lastUpdated:    Date.now(),
  };
  await kv.put(ATTENTION_KEY(userId), JSON.stringify(next), { expirationTtl: ATTENTION_TTL_S });
  return next;
}

function empty(userId) {
  return { userId, focus: [], recentEvents: [], pendingIntents: [], lastUpdated: Date.now() };
}

function mergeUnique(prev, add, cap) {
  if (!add) return prev || [];
  const out = [...(prev || [])];
  for (const x of add) {
    if (!out.includes(x)) out.unshift(x);
  }
  return out.slice(0, cap);
}

function replace(prev, next, cap) {
  if (Array.isArray(next)) return next.slice(0, cap);
  return prev || [];
}
