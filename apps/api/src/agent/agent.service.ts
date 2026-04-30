// Autonomous cortex agent. Couples the deterministic cortex pipeline to a
// permission-gated tool registry so the brain can take real action on its
// own behalf — refocusing attention, stimulating neurons, surfacing
// predicted links, firing follow-up cortex passes, and triggering ingest
// from any data source the user has authorised.
//
// Every step is:
//   • permission-checked against AgentPermissionStore (deny by default)
//   • audit-logged via AuditService (append-only Postgres table)
//   • bounded — no recursive runs, max steps per cycle, rate-limited
//
// The agent never executes a tool the user hasn't explicitly granted; every
// blocked attempt is recorded so the user can see what the brain wanted to
// do but couldn't.

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorId } from '@pkg/shared';
import { AuditService } from '../audit/audit.service';
import { AttentionService } from '../brain/attention.service';
import { BrainService } from '../brain/brain.service';
import { CortexService, type CortexThinkResult } from '../brain/cortex.service';
import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { ReasoningService } from '../reasoning/reasoning.service';
import { SyncOrchestrator } from '../sync/sync.orchestrator';
import {
  AgentPermissionStore,
  type AgentPermissionScope,
} from './agent-permission.store';

const DEFAULT_MAX_STEPS = 6;

export type AgentToolName =
  | 'attend'
  | 'stimulate'
  | 'investigate'
  | 'predict-links'
  | 'propose-edge'
  | 'ingest-from'
  | 'list-data-sources';

export interface AgentToolDescriptor {
  name: AgentToolName;
  description: string;
  /** Permission scope required to invoke. Null means always allowed. */
  permission: AgentPermissionScope | null;
}

const TOOL_REGISTRY: AgentToolDescriptor[] = [
  {
    name: 'attend',
    description:
      'Refocus the spiking layer on a query so the brain physically resonates with that subgraph.',
    permission: 'agent:enact-motor',
  },
  {
    name: 'stimulate',
    description: 'Inject a stimulation pulse into a single neuron.',
    permission: 'agent:enact-motor',
  },
  {
    name: 'investigate',
    description:
      'Fire a follow-up cortex pass anchored on a specific node when the upstream pass left it weakly explored.',
    permission: 'agent:investigate',
  },
  {
    name: 'predict-links',
    description:
      'Surface top Adamic-Adar predicted edges for a node — useful when the agent suspects missing structure.',
    permission: 'agent:predict-links',
  },
  {
    name: 'propose-edge',
    description:
      'Record a proposed edge for the user to confirm. No graph mutation happens without explicit approval.',
    permission: 'agent:propose-edge',
  },
  {
    name: 'ingest-from',
    description:
      'Trigger a sync from a specific configured connector so fresh data lands in the graph.',
    permission: 'agent:ingest:*' as AgentPermissionScope,
  },
  {
    name: 'list-data-sources',
    description:
      'List the connectors the user has configured. Always allowed — the agent needs to know what is possible before asking permission.',
    permission: null,
  },
];

export interface AgentStepRecord {
  tool: AgentToolName;
  args: Record<string, unknown>;
  /** 'ok' = ran; 'denied' = permission missing; 'skipped' = no work to do;
   *  'error' = ran but threw. */
  outcome: 'ok' | 'denied' | 'skipped' | 'error';
  reason?: string;
  result?: unknown;
}

export interface AgentRunReport {
  userId: string;
  startedAt: string;
  finishedAt: string;
  thought: CortexThinkResult;
  steps: AgentStepRecord[];
  /** Convenience: actions in the cortex thought that the agent was *not*
   *  permitted to enact. Helps the SPA prompt the user for grants. */
  blocked: Array<{ tool: AgentToolName; reason: string }>;
}

export interface AgentRunOptions {
  question?: string;
  maxSteps?: number;
  /** Ignore permission-store and run every action regardless. ONLY for tests
   *  and the `/agent/dry-run` admin surface — never used in normal flow. */
  unsafeBypassPermissions?: boolean;
}

@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly cortex: CortexService,
    private readonly attention: AttentionService,
    private readonly brain: BrainService,
    private readonly reasoning: ReasoningService,
    private readonly sync: SyncOrchestrator,
    private readonly configs: ConnectorConfigStore,
    private readonly permissions: AgentPermissionStore,
    private readonly audit: AuditService,
  ) {}

  /** The static catalog of tools the agent can use, with the permission scope
   *  each one requires. */
  tools(): AgentToolDescriptor[] {
    return [...TOOL_REGISTRY];
  }

  /** Currently-configured data sources for `userId`. Useful for the SPA's
   *  "grant ingest permission" UI as well as the agent's own planner. */
  listDataSources(userId: string): Array<{
    id: ConnectorId;
    enabled: boolean;
    lastSyncStatus: string | null;
    lastSyncAt: string | null;
  }> {
    return this.configs.listForUser(userId).map((c) => ({
      id: c.id,
      enabled: c.enabled,
      lastSyncStatus: c.lastSyncStatus ?? null,
      lastSyncAt: c.lastSyncAt ?? null,
    }));
  }

  /**
   * Run one autonomous cycle: think → for each motor action, dispatch the
   * matching tool if permitted, otherwise record it as blocked. Returns a
   * report the SPA can render as a "what the brain just did" panel.
   */
  async run(userId: string, opts: AgentRunOptions = {}): Promise<AgentRunReport> {
    const startedAt = new Date().toISOString();
    const thought = await this.cortex.think(userId, {
      ...(opts.question !== undefined ? { question: opts.question } : {}),
      enact: false, // The agent — not the cortex — decides what to enact.
    });

    const cap = Math.max(1, Math.min(20, opts.maxSteps ?? DEFAULT_MAX_STEPS));
    const steps: AgentStepRecord[] = [];
    const blocked: AgentRunReport['blocked'] = [];

    for (const action of thought.actions.slice(0, cap)) {
      const step = await this.dispatch(userId, action, opts.unsafeBypassPermissions ?? false);
      steps.push(step);
      if (step.outcome === 'denied') {
        blocked.push({ tool: step.tool, reason: step.reason ?? 'denied' });
      }
    }

    const finishedAt = new Date().toISOString();
    void this.audit.record({
      userId,
      action: 'agent.run',
      resource: 'agent',
      metadata: {
        startedAt,
        finishedAt,
        steps: steps.length,
        blocked: blocked.length,
        confidence: thought.confidence,
      },
    });

    this.log.log(
      `agent run user=${userId} steps=${steps.length} blocked=${blocked.length} confidence=${thought.confidence.toFixed(2)}`,
    );

    return { userId, startedAt, finishedAt, thought, steps, blocked };
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async dispatch(
    userId: string,
    action: CortexThinkResult['actions'][number],
    bypass: boolean,
  ): Promise<AgentStepRecord> {
    if (action.kind === 'attend') {
      return this.invoke(userId, 'attend', { query: action.query, reason: action.reason }, bypass, async () => {
        const focus = await this.attention.focus(userId, action.query, { durationMs: 30_000 });
        return { focused: focus.neuronIds.length };
      });
    }
    if (action.kind === 'stimulate') {
      return this.invoke(userId, 'stimulate', { neuronId: action.neuronId, currentMv: action.currentMv, reason: action.reason }, bypass, async () => {
        this.brain.stimulate(userId, action.neuronId, action.currentMv);
        return { stimulated: action.neuronId };
      });
    }
    if (action.kind === 'propose-edge') {
      return this.invoke(
        userId,
        'propose-edge',
        { source: action.source, target: action.target, weight: action.weight, reason: action.reason },
        bypass,
        async () => {
          // Phase 0: emit-only — proposals stay in the audit trail until the
          // user reviews them. Phase 1+ will write into a `pending_edges`
          // table so the SPA can list pending proposals for confirmation.
          await this.audit.record({
            userId,
            action: 'agent.proposed-edge',
            resource: 'graph',
            metadata: {
              source: action.source,
              target: action.target,
              weight: action.weight,
              reason: action.reason,
            },
          });
          return { proposed: true };
        },
      );
    }
    if (action.kind === 'investigate') {
      return this.invoke(userId, 'investigate', { nodeId: action.nodeId, reason: action.reason }, bypass, async () => {
        const summary = await this.reasoning.summarise(userId, action.nodeId);
        return summary;
      });
    }
    return {
      tool: 'list-data-sources',
      args: {},
      outcome: 'skipped',
      reason: `unsupported action kind`,
    };
  }

  /**
   * Run a tool invocation: permission check → execute → record. `executor`
   * does the actual work; everything around it is the safety + audit envelope.
   */
  private async invoke<T>(
    userId: string,
    tool: AgentToolName,
    args: Record<string, unknown>,
    bypass: boolean,
    executor: () => Promise<T>,
  ): Promise<AgentStepRecord> {
    const descriptor = TOOL_REGISTRY.find((t) => t.name === tool);
    if (!descriptor) {
      return { tool, args, outcome: 'error', reason: `unknown tool ${tool}` };
    }
    if (!bypass && descriptor.permission && !this.permissions.has(userId, descriptor.permission)) {
      void this.audit.record({
        userId,
        action: 'agent.tool.denied',
        resource: 'agent',
        metadata: { tool, missingScope: descriptor.permission, args },
      });
      return {
        tool,
        args,
        outcome: 'denied',
        reason: `missing permission ${descriptor.permission}`,
      };
    }
    try {
      const result = await executor();
      void this.audit.record({
        userId,
        action: 'agent.tool',
        resource: 'agent',
        metadata: { tool, args, outcome: 'ok' },
      });
      return { tool, args, outcome: 'ok', result };
    } catch (err) {
      const reason = (err as Error).message ?? String(err);
      void this.audit.record({
        userId,
        action: 'agent.tool.error',
        resource: 'agent',
        metadata: { tool, args, error: reason },
      });
      this.log.warn(`agent tool ${tool} failed user=${userId}: ${reason}`);
      return { tool, args, outcome: 'error', reason };
    }
  }

  /** Trigger a sync from `connectorId` for `userId`. Permission key is
   *  `agent:ingest:<connectorId>` (or the wildcard `agent:ingest:*`). */
  async ingestFrom(
    userId: string,
    connectorId: ConnectorId,
    opts: { unsafeBypassPermissions?: boolean } = {},
  ): Promise<AgentStepRecord> {
    const scope: AgentPermissionScope = `agent:ingest:${connectorId}` as AgentPermissionScope;
    return this.invoke(userId, 'ingest-from', { connectorId }, opts.unsafeBypassPermissions ?? false, async () => {
      // Manual scope check first since `invoke` checks the registry's static
      // scope (which is the wildcard for the ingest tool).
      if (
        !(opts.unsafeBypassPermissions ?? false) &&
        !this.permissions.has(userId, scope) &&
        !this.permissions.has(userId, 'agent:ingest:*' as AgentPermissionScope)
      ) {
        throw new Error(`missing permission ${scope}`);
      }
      const job = this.sync.enqueue({ userId, connectorId });
      return { jobId: job, connectorId };
    });
  }

  /** Surface predicted links for a seed when the agent has the relevant
   *  permission. */
  async predictLinks(
    userId: string,
    seedId: string,
    opts: { limit?: number; unsafeBypassPermissions?: boolean } = {},
  ): Promise<AgentStepRecord> {
    return this.invoke(
      userId,
      'predict-links',
      { seedId, limit: opts.limit ?? 5 },
      opts.unsafeBypassPermissions ?? false,
      async () => {
        return this.reasoning.predictLinks(userId, seedId, 'adamic-adar', opts.limit ?? 5);
      },
    );
  }
}
