// Reasoning-path overlay panel (spec §7.5 "Why this node?"). Presentational:
// it visualizes a cortex reasoning result (the six-phase trace, a confidence
// bar, and proposed motor actions) and lets the canvas highlight the node ids
// touched by each step. The coordinator wires it to GraphView/App — this file
// never imports them.

import { type CSSProperties } from 'react';
import type { GraphNode } from './types';

/** The six cortex phases, in pipeline order (spec §7.5). */
export const REASONING_PHASES = [
  'sensory',
  'limbic',
  'memory',
  'association',
  'executive',
  'motor',
] as const;

export type ReasoningPhase = (typeof REASONING_PHASES)[number];

export interface ReasoningStep {
  phase: ReasoningPhase;
  detail: string;
  nodeIds?: string[];
}

export interface ReasoningAction {
  kind: string;
  detail: string;
}

export interface ReasoningResult {
  seeds: string[];
  steps: ReasoningStep[];
  conclusion: string;
  confidence: number;
  actions: ReasoningAction[];
}

const PHASE_META: Record<ReasoningPhase, { label: string; color: string; glyph: string }> = {
  sensory: { label: 'Sensory', color: '#7c9cff', glyph: '◎' },
  limbic: { label: 'Limbic', color: '#ff9fc4', glyph: '❤' },
  memory: { label: 'Memory', color: '#9be7c4', glyph: '⌘' },
  association: { label: 'Association', color: '#ffd479', glyph: '⨂' },
  executive: { label: 'Executive', color: '#c9a7ff', glyph: '✦' },
  motor: { label: 'Motor', color: '#7fe0ff', glyph: '➤' },
};

export function ReasoningPanel({
  result,
  loading,
  error,
  nodesById,
  onHighlightPath,
  onClose,
}: {
  result: ReasoningResult | null;
  loading: boolean;
  error: string | null;
  nodesById: Map<string, GraphNode>;
  onHighlightPath: (nodeIds: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside style={panelStyle} aria-label="Reasoning path">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...dot, background: '#c9a7ff' }} />
          <strong style={{ fontSize: '1.02rem' }}>Why this node?</strong>
        </div>
        <button type="button" onClick={onClose} style={iconBtn} aria-label="Close panel">
          ✕
        </button>
      </div>

      {loading && <p style={statusText}>Thinking…</p>}

      {error && !loading && <p style={{ ...statusText, color: '#ffb7c4' }}>{error}</p>}

      {!loading && !error && !result && (
        <p style={statusText}>No reasoning result yet. Run a thought to see the cortex trace.</p>
      )}

      {!loading && !error && result && (
        <>
          <Section label={`Seeds (${result.seeds.length})`}>
            {result.seeds.length === 0 ? (
              <span style={{ color: '#7b86a3', fontSize: '0.82rem' }}>None.</span>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {result.seeds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    style={seedChip}
                    title={id}
                    onClick={() => onHighlightPath([id])}
                  >
                    {labelFor(nodesById, id)}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section label={`Trace (${result.steps.length})`}>
            <ol style={traceList}>
              {result.steps.map((step, i) => {
                const meta = PHASE_META[step.phase];
                const ids = step.nodeIds ?? [];
                const highlight = (): void => {
                  if (ids.length > 0) onHighlightPath(ids);
                };
                return (
                  <li
                    key={`${step.phase}-${i}`}
                    style={stepRow}
                    onMouseEnter={highlight}
                    onClick={highlight}
                  >
                    <span style={{ ...stepGlyph, color: meta.color, borderColor: meta.color }} aria-hidden>
                      {meta.glyph}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ ...stepPhase, color: meta.color }}>{meta.label}</div>
                      <div style={stepDetail}>{step.detail}</div>
                      {ids.length > 0 && (
                        <div style={stepNodes}>
                          {ids.slice(0, 8).map((id) => (
                            <span key={id} style={nodeTag} title={id}>
                              {labelFor(nodesById, id)}
                            </span>
                          ))}
                          {ids.length > 8 && (
                            <span style={{ color: '#7b86a3', fontSize: '0.72rem' }}>+{ids.length - 8}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {result.steps.length === 0 && (
                <li style={{ color: '#7b86a3', fontSize: '0.82rem' }}>No steps recorded.</li>
              )}
            </ol>
          </Section>

          <Section label="Conclusion">
            <p style={conclusionText}>{result.conclusion || '—'}</p>
            <div style={{ marginTop: 8 }}>
              <ConfidenceBar value={result.confidence} />
            </div>
          </Section>

          <Section label={`Proposed actions (${result.actions.length})`}>
            {result.actions.length === 0 ? (
              <span style={{ color: '#7b86a3', fontSize: '0.82rem' }}>No actions proposed.</span>
            ) : (
              <ul style={actionList}>
                {result.actions.map((a, i) => (
                  <li key={`${a.kind}-${i}`} style={actionRow}>
                    <span style={actionKind}>{a.kind}</span>
                    <span style={actionDetail}>{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <strong style={sectionLabel}>{label}</strong>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }): JSX.Element {
  const pct = Math.round(clamp01(value) * 100);
  const hue = Math.round(clamp01(value) * 120); // red → green
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#aab3cc' }}>
        <span>Confidence</span>
        <span>{pct}%</span>
      </div>
      <div style={barTrack} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ ...barFill, width: `${pct}%`, background: `hsl(${hue}, 70%, 55%)` }} />
      </div>
    </div>
  );
}

function labelFor(nodesById: Map<string, GraphNode>, id: string): string {
  return nodesById.get(id)?.label ?? id;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Client helper: POST a seed to the cortex `think` endpoint. Best-effort — the
// endpoint shape may still evolve, so the response is parsed from `unknown`
// with defensive narrowing rather than a hard cast.
// ---------------------------------------------------------------------------

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

export async function requestThink(userId: string, seedNodeId: string): Promise<ReasoningResult> {
  const url = new URL(`${API_BASE}/brain/cortex/think`, window.location.origin);
  url.searchParams.set('userId', userId);
  const res = await fetch(`${url.pathname}${url.search}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ userId, seedNodeId, seeds: [seedNodeId] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  const raw: unknown = await res.json().catch(() => null);
  return normalizeResult(raw, seedNodeId);
}

/** Coerce an unknown server payload into a `ReasoningResult`, tolerating
 *  missing/extra fields and alternate shapes. */
export function normalizeResult(raw: unknown, fallbackSeed?: string): ReasoningResult {
  const obj = isRecord(raw) ? raw : {};

  const seeds = asStringArray(obj.seeds);
  if (seeds.length === 0 && typeof fallbackSeed === 'string') seeds.push(fallbackSeed);

  const steps = Array.isArray(obj.steps) ? obj.steps.map(toStep).filter(isStep) : [];
  const actions = Array.isArray(obj.actions) ? obj.actions.map(toAction) : [];

  return {
    seeds,
    steps,
    conclusion: typeof obj.conclusion === 'string' ? obj.conclusion : '',
    confidence: toConfidence(obj.confidence),
    actions,
  };
}

function toStep(raw: unknown): ReasoningStep | null {
  if (!isRecord(raw)) return null;
  const phase = isPhase(raw.phase) ? raw.phase : null;
  if (!phase) return null;
  const step: ReasoningStep = {
    phase,
    detail: typeof raw.detail === 'string' ? raw.detail : '',
  };
  const ids = asStringArray(raw.nodeIds);
  if (ids.length > 0) step.nodeIds = ids;
  return step;
}

function isStep(s: ReasoningStep | null): s is ReasoningStep {
  return s !== null;
}

function toAction(raw: unknown): ReasoningAction {
  if (!isRecord(raw)) return { kind: 'action', detail: String(raw ?? '') };
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : 'action',
    detail: typeof raw.detail === 'string' ? raw.detail : '',
  };
}

function toConfidence(raw: unknown): number {
  return typeof raw === 'number' ? clamp01(raw) : 0;
}

function isPhase(v: unknown): v is ReasoningPhase {
  return typeof v === 'string' && (REASONING_PHASES as readonly string[]).includes(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// --- styles (dark theme, mirrors NodePanel) --------------------------------

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  bottom: 12,
  width: 340,
  overflowY: 'auto',
  background: 'rgba(17,23,42,0.94)',
  border: '1px solid #1f2740',
  borderRadius: 16,
  padding: '1rem',
  boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)',
  zIndex: 5,
};
const dot: CSSProperties = { width: 12, height: 12, borderRadius: 999, flex: '0 0 auto' };
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#8fa0c8',
  cursor: 'pointer',
  fontSize: '1rem',
};
const statusText: CSSProperties = { color: '#aab3cc', fontSize: '0.85rem', marginTop: 16 };
const sectionLabel: CSSProperties = {
  fontSize: '0.82rem',
  color: '#aab3cc',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};
const seedChip: CSSProperties = {
  background: '#0d1324',
  border: '1px solid #2a3658',
  borderRadius: 999,
  padding: '0.25rem 0.6rem',
  color: '#dce5ff',
  cursor: 'pointer',
  fontSize: '0.78rem',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const traceList: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 };
const stepRow: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  background: '#0d1324',
  border: '1px solid #1c2540',
  borderRadius: 10,
  padding: '0.5rem 0.6rem',
  cursor: 'pointer',
};
const stepGlyph: CSSProperties = {
  flex: '0 0 auto',
  width: 22,
  height: 22,
  lineHeight: '20px',
  textAlign: 'center',
  borderRadius: 999,
  border: '1px solid',
  fontSize: '0.78rem',
};
const stepPhase: CSSProperties = {
  fontSize: '0.72rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 600,
};
const stepDetail: CSSProperties = { color: '#dce5ff', fontSize: '0.82rem', wordBreak: 'break-word' };
const stepNodes: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 };
const nodeTag: CSSProperties = {
  background: '#111a30',
  border: '1px solid #243153',
  borderRadius: 6,
  padding: '0.1rem 0.35rem',
  color: '#9fb0d6',
  fontSize: '0.72rem',
  maxWidth: 140,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const conclusionText: CSSProperties = { color: '#dce5ff', fontSize: '0.88rem', margin: 0, wordBreak: 'break-word' };
const barTrack: CSSProperties = {
  marginTop: 4,
  height: 8,
  background: '#0a0e1a',
  border: '1px solid #1c2540',
  borderRadius: 999,
  overflow: 'hidden',
};
const barFill: CSSProperties = { height: '100%', borderRadius: 999, transition: 'width 0.25s ease' };
const actionList: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 };
const actionRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  background: '#0d1324',
  border: '1px solid #1c2540',
  borderRadius: 8,
  padding: '0.4rem 0.55rem',
};
const actionKind: CSSProperties = {
  color: '#7fe0ff',
  fontSize: '0.72rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  flex: '0 0 auto',
};
const actionDetail: CSSProperties = { color: '#dce5ff', fontSize: '0.82rem', wordBreak: 'break-word' };
