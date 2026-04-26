// Motor cortex safety kernel. Every external side-effect the brain wants to
// take — sending a message, executing an MCP tool, committing code — must
// pass through `evaluate()` first. Rules run in order; the first one that
// returns a verdict short-circuits, so allowed intents are decided last
// (after all blockers have had a chance to veto).
//
// Phase 0 keeps the rule set deliberately conservative: low-confidence
// intents are dropped, anything matching a denylist substring is blocked,
// per-action rate limits cap noise, and a small set of high-impact verbs
// are forced through a "requires-approval" gate until Phase 1 ships a real
// human-in-the-loop queue.

import { Injectable, Logger } from '@nestjs/common';

export interface MotorIntent {
  /** Verb — `send_email`, `execute_mcp_tool`, `commit_changes`, etc. */
  action: string;
  /** Free-form payload — supervisor should not interpret. */
  payload: Record<string, unknown>;
  /** Originating neuron id (motor cortex). */
  neuronId: string;
  /** Activation strength 0..1 — how confident the brain is in this action. */
  confidence: number;
}

export type SafetyVerdict =
  | { allow: true; reason: 'within-limits' }
  | {
      allow: false;
      reason: 'rate-limited' | 'low-confidence' | 'denylisted' | 'requires-approval';
      detail?: string;
    };

export interface SupervisorDecision {
  intent: MotorIntent;
  verdict: SafetyVerdict;
  t: number;
}

interface SupervisorContext {
  recent: SupervisorDecision[];
  now: number;
}

interface SupervisorRule {
  check(intent: MotorIntent, ctx: SupervisorContext): SafetyVerdict | null;
}

const RECENT_WINDOW_MS = 60_000;
const PER_ACTION_LIMIT = 6;
const MIN_CONFIDENCE = 0.35;
const RING_BUFFER_MAX = 1024;

const DENYLIST_SUBSTRINGS = [
  'rm -rf',
  'DROP TABLE',
  'wire transfer',
  'execute trade',
];

const REQUIRES_APPROVAL_ACTIONS = new Set([
  'commit_changes',
  'send_email',
  'execute_mcp_tool',
  'transfer_funds',
  'execute_trade',
]);

const RULES: SupervisorRule[] = [
  (function rule_lowConfidence(): SupervisorRule {
    return {
      check(intent) {
        if (intent.confidence < MIN_CONFIDENCE) {
          return {
            allow: false,
            reason: 'low-confidence',
            detail: `${intent.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`,
          };
        }
        return null;
      },
    };
  })(),
  (function rule_denylist(): SupervisorRule {
    return {
      check(intent) {
        const blob = JSON.stringify(intent.payload).toLowerCase();
        for (const s of DENYLIST_SUBSTRINGS) {
          if (blob.includes(s.toLowerCase())) {
            return { allow: false, reason: 'denylisted', detail: s };
          }
        }
        return null;
      },
    };
  })(),
  (function rule_rateLimit(): SupervisorRule {
    return {
      check(intent, ctx) {
        const cutoff = ctx.now - RECENT_WINDOW_MS;
        let same = 0;
        for (const r of ctx.recent) {
          if (
            r.t > cutoff &&
            r.intent.action === intent.action &&
            r.verdict.allow
          ) {
            same += 1;
          }
        }
        if (same >= PER_ACTION_LIMIT) {
          return {
            allow: false,
            reason: 'rate-limited',
            detail: `${same}/${PER_ACTION_LIMIT}/min`,
          };
        }
        return null;
      },
    };
  })(),
  (function rule_approval(): SupervisorRule {
    return {
      check(intent) {
        if (REQUIRES_APPROVAL_ACTIONS.has(intent.action)) {
          return { allow: false, reason: 'requires-approval', detail: intent.action };
        }
        return null;
      },
    };
  })(),
];

@Injectable()
export class SafetySupervisor {
  private readonly log = new Logger(SafetySupervisor.name);
  private readonly recent: SupervisorDecision[] = [];

  evaluate(intent: MotorIntent): SafetyVerdict {
    const ctx: SupervisorContext = { recent: this.recent, now: Date.now() };
    let verdict: SafetyVerdict = { allow: true, reason: 'within-limits' };
    for (const rule of RULES) {
      const v = rule.check(intent, ctx);
      if (v) {
        verdict = v;
        break;
      }
    }
    this.recent.push({ intent, verdict, t: ctx.now });
    while (this.recent.length > RING_BUFFER_MAX) this.recent.shift();
    if (!verdict.allow) {
      const tail = verdict.detail ? `: ${verdict.detail}` : '';
      this.log.warn(`BLOCK ${intent.action} (${verdict.reason}${tail})`);
    }
    return verdict;
  }

  recentDecisions(limit = 50): SupervisorDecision[] {
    return this.recent.slice(-limit).reverse();
  }
}
