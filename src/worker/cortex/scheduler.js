// Cron-driven autonomy. The Worker exports `scheduled()` (in src/worker.js)
// which dispatches here based on the cron expression that fired.
//
// Three cadences (UTC):
//   '*/15 * * * *' → pulse:   Has anything new arrived? Top-of-mind only.
//   '0 * * * *'    → hourly:  Summarize the last hour, surface forming themes.
//   '0 7 * * *'    → daily:   Reflect on the last 24h and write a synthesis note.
//
// Each schedule:
//   1. Picks its prompt + budget from CRON_PLAYBOOK.
//   2. Skips if the watermark in KV says we already ran for this window
//      (idempotent against double cron firings).
//   3. Skips if zero new events in the period (don't reason about nothing).
//   4. Calls cortex.think() with a system question + small step budget.
//   5. Writes a `scheduled-think` event to D1 with the trace + final answer.
//   6. Updates the watermark in KV.
//
// Manual trigger: POST /api/v1/cortex/schedules/:name/run

import { recordEvent } from '../d1-store.js';
import { think } from './reason.js';

const WATERMARK_KEY = (userId, name) => `schedule:${userId}:${name}:lastRun`;

export const CRON_PLAYBOOK = {
  '*/15 * * * *': {
    name: 'pulse',
    windowMs: 15 * 60_000,
    minNewEvents: 1,
    budgetMs: 8_000,
    budgetSteps: 3,
    prompt:
      'A pulse check has fired. In one Thought, decide if anything that arrived in the last 15 minutes deserves attention. ' +
      'Use recent-events first. If nothing new is interesting, finalize "nothing notable". ' +
      'If something IS notable, finalize a one-sentence summary mentioning the relevant node ids.',
  },
  '0 * * * *': {
    name: 'hourly',
    windowMs: 60 * 60_000,
    minNewEvents: 2,
    budgetMs: 12_000,
    budgetSteps: 4,
    prompt:
      'An hourly digest is due. Pull recent-events for the last hour, then use recall to find the strongest theme. ' +
      'Finalize a 2-3 sentence summary identifying the dominant topic and the most-touched node id. ' +
      'If the hour was quiet, finalize "quiet hour" with the count of events.',
  },
  '0 7 * * *': {
    name: 'daily',
    windowMs: 24 * 60 * 60_000,
    minNewEvents: 3,
    budgetMs: 20_000,
    budgetSteps: 6,
    prompt:
      'A daily reflection is due. Across the last 24 hours: (1) call recent-events with limit 50, ' +
      '(2) call recall on the dominant phrase from those events, (3) write-note a 3-bullet synthesis ' +
      'titled "Daily reflection — <UTC date>" describing themes, surprises, and one open question. ' +
      'Finalize with the new note id.',
  },
};

export function listSchedules() {
  return Object.entries(CRON_PLAYBOOK).map(([cron, p]) => ({
    cron, name: p.name,
    windowMs: p.windowMs,
    minNewEvents: p.minNewEvents,
    budgetMs: p.budgetMs,
    budgetSteps: p.budgetSteps,
    prompt: p.prompt,
  }));
}

/**
 * Run one scheduled think for one user. Used both by `scheduled()` (cron)
 * and by `POST /api/v1/cortex/schedules/:name/run` (manual).
 *
 * Idempotency: a watermark key in KV stores the last-run epoch ms. If a
 * cron fires twice within the same window, the second call short-circuits.
 * The manual route can pass `force: true` to bypass.
 */
export async function runSchedule({ env, userId, name, force = false }) {
  const entry = Object.values(CRON_PLAYBOOK).find((p) => p.name === name);
  if (!entry) return { ok: false, error: `unknown schedule: ${name}` };

  const startedAt = Date.now();
  const watermarkKey = WATERMARK_KEY(userId, name);

  // 1) Idempotency check
  if (!force && env.GRAPH_KV) {
    const last = parseInt((await env.GRAPH_KV.get(watermarkKey)) || '0', 10);
    if (last && startedAt - last < entry.windowMs / 2) {
      return { ok: true, skipped: 'idempotent', lastRun: last, name, userId };
    }
  }

  // 2) Activity check — skip if nothing happened
  let newCount = 0;
  if (env.GRAPH_DB) {
    const since = startedAt - entry.windowMs;
    const row = await env.GRAPH_DB
      .prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND ts >= ?')
      .bind(userId, since)
      .first();
    newCount = row?.n ?? 0;
    if (!force && newCount < entry.minNewEvents) {
      // Still log the skip so we can see the cortex tried.
      if (env.GRAPH_DB) {
        await recordEvent(env.GRAPH_DB, {
          userId, sourceKind: 'cortex', kind: 'scheduled-think',
          payload: { schedule: name, status: 'skipped-quiet', newCount, windowMs: entry.windowMs },
          nodeCount: 0, edgeCount: 0,
          status: 'applied',
        });
      }
      if (env.GRAPH_KV) {
        await env.GRAPH_KV.put(watermarkKey, String(startedAt));
      }
      return { ok: true, skipped: 'quiet', newCount, name, userId, elapsedMs: Date.now() - startedAt };
    }
  }

  // 3) Run the loop
  let result;
  try {
    result = await think(env, {
      userId,
      question: entry.prompt,
      budgetMs: entry.budgetMs,
      budgetSteps: entry.budgetSteps,
    });
  } catch (err) {
    if (env.GRAPH_DB) {
      await recordEvent(env.GRAPH_DB, {
        userId, sourceKind: 'cortex', kind: 'scheduled-think',
        payload: { schedule: name, error: err.message },
        nodeCount: 0, edgeCount: 0,
        status: 'error', error: err.message,
      });
    }
    return { ok: false, error: err.message, name, userId };
  }

  // 4) Persist as an event so the timeline + recent-events pick it up
  if (env.GRAPH_DB) {
    await recordEvent(env.GRAPH_DB, {
      userId, sourceKind: 'cortex', kind: 'scheduled-think',
      payload: {
        schedule: name,
        question: entry.prompt,
        finalAnswer: result.finalAnswer,
        steps: result.trace?.length || 0,
        elapsedMs: result.elapsedMs,
        newCount,
      },
      nodeCount: 0, edgeCount: 0,
      status: result.ok ? 'applied' : 'error',
      error: result.ok ? null : result.error,
    });
  }

  // 5) Update watermark
  if (env.GRAPH_KV) {
    await env.GRAPH_KV.put(watermarkKey, String(startedAt));
  }

  return {
    ok: result.ok,
    name, userId,
    elapsedMs: Date.now() - startedAt,
    newCount,
    finalAnswer: result.finalAnswer,
    steps: result.trace?.length || 0,
  };
}

/** Dispatched from the Worker `scheduled()` handler. Runs one schedule for
 *  every user in AUTONOMY_USER_IDS. Errors are logged + swallowed so a
 *  per-user failure doesn't block the rest. */
export async function dispatchCron(env, cronExpression) {
  const playbook = CRON_PLAYBOOK[cronExpression];
  if (!playbook) {
    console.warn('[scheduler] unknown cron expression:', cronExpression);
    return;
  }
  const csv = (env.AUTONOMY_USER_IDS || env.PUBLIC_INGEST_USER_IDS || '').toString();
  const users = csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (!users.length) {
    console.warn('[scheduler] no AUTONOMY_USER_IDS configured');
    return;
  }
  for (const userId of users) {
    try {
      const out = await runSchedule({ env, userId, name: playbook.name });
      console.log(`[scheduler] ${playbook.name} userId=${userId} →`, JSON.stringify(out));
    } catch (err) {
      console.error(`[scheduler] ${playbook.name} userId=${userId} crashed:`, err.message);
    }
  }
}
