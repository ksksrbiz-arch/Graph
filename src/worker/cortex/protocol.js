// Cortex Protocol v1 — versioned message envelope used by every client
// (sensors, tools, reasoners) talking to the compositor. Inspired by
// Wayland: a single dispatcher, capability-negotiating clients.
//
// JSDoc shapes (we're in a Worker so no TS at runtime):
//
//   @typedef {'perceive' | 'recall' | { kind:'act', intent:string }} Capability
//
//   @typedef CortexEnvelope
//     v: 1
//     client: string                       stable client UUID
//     capabilities?: Capability[]
//     ts?: number                          ms epoch (server fills if missing)
//
//   @typedef {CortexEnvelope & {kind:'perceive', modality:'text'|'url'|'voice'|'vision'|'webhook'|'graph', source:string, payload:any}} PerceiveMessage
//   @typedef {CortexEnvelope & {kind:'think',    question?:string, budgetMs?:number, budgetSteps?:number}}                            ThinkMessage
//   @typedef {CortexEnvelope & {kind:'act',      intent:string, args:Record<string,any>, callId:string}}                              ActMessage
//   @typedef {CortexEnvelope & {kind:'observe',  callId:string, ok:boolean, result?:any, error?:string}}                              ObserveMessage

export const PROTOCOL_VERSION = 1;

export const KNOWN_MODALITIES = new Set([
  'text', 'url', 'voice', 'vision', 'webhook', 'graph', 'event',
]);

/** Envelope-stamp a message. Mutates + returns. */
export function stamp(msg, { clientFallback = 'compositor' } = {}) {
  msg.v = PROTOCOL_VERSION;
  if (!msg.client) msg.client = clientFallback;
  if (!msg.ts) msg.ts = Date.now();
  return msg;
}

export function isPerceive(m) { return m && m.kind === 'perceive' && KNOWN_MODALITIES.has(m.modality); }
export function isThink(m)    { return m && m.kind === 'think'; }
export function isAct(m)      { return m && m.kind === 'act'   && typeof m.intent === 'string'; }
export function isObserve(m)  { return m && m.kind === 'observe' && typeof m.callId === 'string'; }
