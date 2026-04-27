// Sensory output adapter — wraps Workers AI Aura-1 TTS so the cortex can
// speak. Voice in (Whisper) and vision in (Llava) are inlined in router.js
// per PR #46. This module covers Layer 11 only: text-to-speech as a tool the
// reasoner can call.
//
// All errors caught + returned as { ok, error } so a flaky model call never
// crashes a tool dispatch.

const TTS_MODEL = '@cf/deepgram/aura-1';
const TTS_MAX_CHARS = 2_000;

/**
 * Synthesize speech via Deepgram Aura-1. Returns a base64-encoded MP3
 * suitable for embedding in a data: URL (or in JSON for the SPA to play).
 *
 * Aura's response shape varies by Workers AI runtime — sometimes a
 * ReadableStream, sometimes a Response, sometimes { audio: base64 }.
 * This normalizer accepts all three.
 */
export async function speakText(env, text, opts = {}) {
  if (!env.AI) return { ok: false, error: 'AI binding missing' };
  const cleaned = (text || '').toString().trim().slice(0, TTS_MAX_CHARS);
  if (!cleaned) return { ok: false, error: 'text required' };
  try {
    const out = await env.AI.run(TTS_MODEL, {
      text: cleaned,
      voice: (opts.voice || 'asteria').toString().slice(0, 30),
    });
    let bytes;
    if (out instanceof ReadableStream) {
      bytes = await streamToBytes(out);
    } else if (out && typeof out.arrayBuffer === 'function') {
      bytes = new Uint8Array(await out.arrayBuffer());
    } else if (out instanceof ArrayBuffer) {
      bytes = new Uint8Array(out);
    } else if (out && out.audio) {
      bytes = base64ToBytes(out.audio);
    } else {
      return { ok: false, error: 'unrecognized TTS response shape' };
    }
    return {
      ok: true,
      mimeType: 'audio/mpeg',
      bytes: bytes.byteLength,
      audioBase64: bytesToBase64(bytes),
      text: cleaned,
      voice: opts.voice || 'asteria',
    };
  } catch (err) {
    return { ok: false, error: `aura failed: ${err.message}` };
  }
}

async function streamToBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
