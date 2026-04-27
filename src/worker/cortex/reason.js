// The ReAct loop. One think() call =
//   read attention → compose prompt → call AI → parse → maybe dispatch a
//   tool → record observation → repeat until {finalAnswer, budget exhausted,
//   or step cap}.
//
// The trace returned to the caller is the live thought stream, suitable for
// rendering as the JARVIS-style "thinking" panel in the SPA.

import { listEvents } from '../d1-store.js';
import { readAttention, writeAttention } from './attention.js';
import { describeTools, dispatch } from './tools.js';
import { recall as vectorRecall } from './vector.js';

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const DEFAULT_BUDGET_MS = 15_000;
const DEFAULT_BUDGET_STEPS = 6;
const SYSTEM_PROMPT = `You are CORTEX — a reasoning agent embedded in a personal knowledge graph.

You will see a question and a set of TOOLS. Pick exactly ONE next action and stop.
After your single action, the system will run the tool and SHOW you the result on the next turn.
Do not pretend to see results that haven't happened yet. Do not write multiple steps in one response.

Available tools:
{TOOLS}

Output format — exactly three lines, nothing else:
Thought: <one short sentence: what are you doing this turn?>
Action: <tool intent from the list above, OR "final" when you can answer>
Action Input: <ONE JSON object on one line: {"key":"value"}, OR your final prose answer if Action is final>

Hard rules:
- Stop after Action Input. Don't write a second Thought.
- If you've already called the same tool with the same args this session, call "final" instead.
- Don't invent observations. The system shows them to you below.
- Final answers are plain English, not JSON, not markdown fences.

Working memory (most recent first):
{ATTENTION}

User question:
{QUESTION}`;

export async function think(env, { userId, question, budgetMs, budgetSteps, model }) {
  if (!env.AI) {
    return { ok: false, error: 'AI binding missing — add "ai" to wrangler.jsonc', trace: [] };
  }
  const startedAt = Date.now();
  const trace = [];
  const stepCap = clampInt(budgetSteps, 1, 12, DEFAULT_BUDGET_STEPS);
  const wallCap = clampInt(budgetMs, 1_000, 60_000, DEFAULT_BUDGET_MS);
  const usedModel = (model && String(model)) || env.CORTEX_MODEL || DEFAULT_MODEL;

  const attention = await readAttention(env.GRAPH_KV, userId);
  const recentEvents = await listEvents(env.GRAPH_DB, { userId, limit: 10 });

  const ctx = { userId, attention, recentEvents, observations: [], recalled: [] };
  // Diagnostic: surface what recall pulled before the loop starts.
  trace.push({ step: 0, kind: 'pre', recentCount: recentEvents.length, attentionFocus: attention.focus.length });
  if (question && env.VECTORS && env.AI) {
    try {
      const r = await vectorRecall(env, userId, question, { topK: 6 });
      if (r.ok) ctx.recalled = r.matches;
      trace.push({ step: 0, kind: 'recalled', count: ctx.recalled.length, top3: ctx.recalled.slice(0,3).map(m=>({nodeId:m.nodeId,label:m.label?.slice(0,80),score:m.score})) });
    } catch (err) {
      // Recall failure is non-fatal — the loop still runs without it.
      console.warn('[reason] pre-recall failed:', err.message);
    }
  }
  let final = null;

  for (let step = 1; step <= stepCap; step++) {
    if (Date.now() - startedAt > wallCap) {
      trace.push({ step, kind: 'budget-exhausted', wallMs: Date.now() - startedAt });
      break;
    }

    const prompt = renderPrompt({ question, ctx, tools: await describeTools(env, { userId }) });
    let raw;
    try {
      const r = await env.AI.run(usedModel, {
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user',   content: prompt.user },
        ],
        max_tokens: 512,
      });
      raw = (r?.response || '').trim();
    } catch (err) {
      trace.push({ step, kind: 'ai-error', error: err.message });
      break;
    }

    const parsed = parseReact(raw);
    trace.push({ step, kind: 'thought', thought: parsed.thought, raw });

    if (parsed.action === 'final' || !parsed.action) {
      final = parsed.actionInput || raw;
      trace.push({ step, kind: 'final', answer: final });
      break;
    }

    let inputArgs;
    try {
      inputArgs = parsed.actionInput && typeof parsed.actionInput === 'string'
        ? JSON.parse(parsed.actionInput)
        : (parsed.actionInput || {});
    } catch {
      // Tool input wasn't JSON — pass as raw string so the tool can fail gracefully.
      inputArgs = { _raw: parsed.actionInput };
    }

    trace.push({ step, kind: 'action', intent: parsed.action, args: inputArgs });
    const observation = await dispatch(env, parsed.action, inputArgs, { userId });
    trace.push({ step, kind: 'observation', intent: parsed.action, ok: observation.ok, result: observation.result, error: observation.error });
    ctx.observations.push({ intent: parsed.action, args: inputArgs, observation });
  }

  // Persist updated working memory so the next /think picks up where we left off.
  await writeAttention(env.GRAPH_KV, userId, {
    recentEvents: recentEvents.slice(0, 20).map((e) => e.id),
    pendingIntents: [],
  });

  return {
    ok: true,
    model: usedModel,
    elapsedMs: Date.now() - startedAt,
    finalAnswer: final,
    trace,
  };
}

// ── prompt assembly ───────────────────────────────────────────────────

function renderPrompt({ question, ctx, tools }) {
  const toolBlock = tools.map((t) => `  - ${t.intent}: ${t.description}`).join('\n');
  const attentionBlock = renderAttention(ctx.attention, ctx.recentEvents, ctx.observations);
  const system = SYSTEM_PROMPT
    .replace('{TOOLS}', toolBlock)
    .replace('{RECALLED}', renderRecalled(ctx.recalled))
    .replace('{ATTENTION}', attentionBlock)
    .replace('{QUESTION}', question || '(no explicit question — what should I look at next?)');
  return { system, user: question || 'Pick one useful thing to do next and do it.' };
}

function renderAttention(att, recent, observations) {
  const lines = [];
  if (att?.focus?.length) lines.push(`focus node ids: ${att.focus.slice(0, 8).join(', ')}`);
  if (recent?.length) {
    lines.push('recent events:');
    for (const e of recent.slice(0, 6)) {
      lines.push(`  • [${e.kind}/${e.source_kind}] ${e.node_count} nodes / ${e.edge_count} edges (id=${e.id.slice(0, 8)})`);
    }
  }
  if (observations?.length) {
    lines.push('observations so far:');
    for (const o of observations.slice(-3)) {
      lines.push(`  • ${o.intent}: ${o.observation.ok ? 'ok' : 'err='+o.observation.error} → ${truncate(JSON.stringify(o.observation.result || ''), 200)}`);
    }
  }
  return lines.join('\n') || '(empty — first cycle)';
}

// ── ReAct parsing ─────────────────────────────────────────────────────
//
// Tolerant parser. Looks for tagged blocks (Thought:, Action:, Action Input:)
// and falls back to whole-response-as-final if the model ignored the format.

const RX = {
  thought: /Thought\s*:\s*(.+?)(?=\n[A-Z][a-z]+\s*:|\n*$)/is,
  action:  /Action\s*:\s*([a-z0-9_:-]+)/i,
  input:   /Action\s+Input\s*:\s*([\s\S]+?)(?=\n[A-Z][a-z]+\s*:|\s*$)/i,
};

export function parseReact(text) {
  let t = (text || '').trim();
  t = truncateAtSecondStep(t);
  const thought = (RX.thought.exec(t)?.[1] || '').trim();
  const action  = (RX.action.exec(t)?.[1]  || '').trim().toLowerCase();
  const rawIn   = (RX.input.exec(t)?.[1]   || '').trim();
  return {
    thought: thought || (action ? '' : t),
    action: action || (thought ? null : 'final'),
    actionInput: rawIn || (action ? '' : t),
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}


// Strip everything after the first blank-line OR a second "Thought:" so the
// reasoner can't pretend it already saw an observation.
function truncateAtSecondStep(t) {
  const blank = t.search(/\n\s*\n/);
  const second = t.indexOf('\nThought', t.indexOf('Thought') + 1);
  const cuts = [blank, second].filter((n) => n > 0);
  if (cuts.length === 0) return t;
  return t.slice(0, Math.min(...cuts)).trim();
}


function renderRecalled(matches) {
  if (!matches?.length) return '(none)';
  return matches
    .slice(0, 6)
    .map((m, i) => `  ${i+1}. [${m.type}] ${m.label} (id=${m.nodeId?.slice(0,8)}, score=${m.score?.toFixed?.(3) ?? m.score})`)
    .join('\n');
}
