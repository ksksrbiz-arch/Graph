import type { CortexAction } from '@pkg/cortex';
import type { ConnectorConfig, ConnectorId } from '@pkg/shared';
import type { AuditService } from '../audit/audit.service';
import type { AttentionService } from '../brain/attention.service';
import type { BrainService } from '../brain/brain.service';
import type { CortexService, CortexThinkResult } from '../brain/cortex.service';
import type { ConnectorConfigStore } from '../connectors/connector-config.store';
import type { ReasoningService } from '../reasoning/reasoning.service';
import type { SyncOrchestrator } from '../sync/sync.orchestrator';
import { AgentPermissionStore } from './agent-permission.store';
import { AgentService } from './agent.service';

function thoughtWith(actions: CortexAction[]): CortexThinkResult {
  return {
    question: 'q',
    seeds: [{ id: 'seed' }],
    memories: [{ id: 'mem' }],
    associations: [],
    conclusion: 'concluded',
    confidence: 0.5,
    actions,
    trace: [],
    elapsedMs: 1,
    enacted: [],
  };
}

interface BuildOpts {
  actions?: CortexAction[];
  configs?: ConnectorConfig[];
}

function build(opts: BuildOpts = {}) {
  const cortex = {
    think: jest.fn().mockResolvedValue(thoughtWith(opts.actions ?? [])),
  } as unknown as CortexService;
  const attention = {
    focus: jest.fn().mockResolvedValue({ neuronIds: ['n1'] }),
  } as unknown as AttentionService;
  const brain = {
    stimulate: jest.fn(),
  } as unknown as BrainService;
  const reasoning = {
    summarise: jest.fn().mockResolvedValue({ nodeId: 'x', degree: 0, neighbourTypes: {}, topNeighbour: null }),
    predictLinks: jest.fn().mockResolvedValue([]),
  } as unknown as ReasoningService;
  const sync = {
    enqueue: jest.fn().mockReturnValue('job-1'),
  } as unknown as SyncOrchestrator;
  const configs = {
    listForUser: jest.fn().mockReturnValue(opts.configs ?? []),
  } as unknown as ConnectorConfigStore;
  const permissions = new AgentPermissionStore();
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;

  const svc = new AgentService(cortex, attention, brain, reasoning, sync, configs, permissions, audit);
  return { svc, cortex, attention, brain, reasoning, sync, configs, permissions, audit };
}

describe('AgentService', () => {
  it('blocks every motor action when no permissions are granted', async () => {
    const actions: CortexAction[] = [
      { kind: 'attend', query: 'cortex', reason: 'x' },
      { kind: 'stimulate', neuronId: 'n1', currentMv: 18, reason: 'y' },
    ];
    const { svc, attention, brain } = build({ actions });
    const report = await svc.run('u1');
    expect(attention.focus).not.toHaveBeenCalled();
    expect(brain.stimulate).not.toHaveBeenCalled();
    expect(report.steps.every((s) => s.outcome === 'denied')).toBe(true);
    expect(report.blocked).toHaveLength(2);
  });

  it('runs motor actions when the agent:enact-motor scope is granted', async () => {
    const actions: CortexAction[] = [
      { kind: 'attend', query: 'cortex', reason: 'x' },
      { kind: 'stimulate', neuronId: 'n1', currentMv: 18, reason: 'y' },
    ];
    const { svc, permissions, attention, brain, audit } = build({ actions });
    permissions.grant('u1', 'agent:enact-motor');

    const report = await svc.run('u1');
    expect(attention.focus).toHaveBeenCalledWith('u1', 'cortex', expect.any(Object));
    expect(brain.stimulate).toHaveBeenCalledWith('u1', 'n1', 18);
    expect(report.steps.every((s) => s.outcome === 'ok')).toBe(true);
    expect(audit.record).toHaveBeenCalled();
  });

  it('records propose-edge actions only as audit entries (no graph mutation)', async () => {
    const actions: CortexAction[] = [
      { kind: 'propose-edge', source: 'a', target: 'b', weight: 0.7, reason: 'aa' },
    ];
    const { svc, permissions, audit } = build({ actions });
    permissions.grant('u1', 'agent:propose-edge');

    const report = await svc.run('u1');
    expect(report.steps[0]!.outcome).toBe('ok');
    const proposed = (audit.record as jest.Mock).mock.calls.find(
      ([call]) => (call as { action: string }).action === 'agent.proposed-edge',
    );
    expect(proposed).toBeDefined();
  });

  it('investigate calls reasoning.summarise when permitted', async () => {
    const actions: CortexAction[] = [
      { kind: 'investigate', nodeId: 'weak', reason: 'low salience' },
    ];
    const { svc, permissions, reasoning } = build({ actions });
    permissions.grant('u1', 'agent:investigate');

    await svc.run('u1');
    expect(reasoning.summarise).toHaveBeenCalledWith('u1', 'weak');
  });

  it('ingestFrom denies without the matching permission', async () => {
    const { svc, sync } = build();
    const result = await svc.ingestFrom('u1', 'gmail' as ConnectorId);
    expect(result.outcome).toBe('denied');
    expect(sync.enqueue).not.toHaveBeenCalled();
  });

  it('ingestFrom enqueues a sync when the wildcard permission is granted', async () => {
    const { svc, permissions, sync } = build();
    permissions.grant('u1', 'agent:ingest:*');
    const result = await svc.ingestFrom('u1', 'gmail' as ConnectorId);
    expect(result.outcome).toBe('ok');
    expect(sync.enqueue).toHaveBeenCalledWith({ userId: 'u1', connectorId: 'gmail' });
    expect((result.result as { jobId: string }).jobId).toBe('job-1');
  });

  it('predictLinks denies without the agent:predict-links scope', async () => {
    const { svc, reasoning } = build();
    const result = await svc.predictLinks('u1', 'seed');
    expect(result.outcome).toBe('denied');
    expect(reasoning.predictLinks).not.toHaveBeenCalled();
  });

  it('listDataSources surfaces configured connectors', () => {
    const { svc } = build({
      configs: [
        {
          id: 'gmail',
          userId: 'u1',
          enabled: true,
          credentials: {} as never,
          syncIntervalMinutes: 30,
          lastSyncAt: '2024-01-01T00:00:00Z',
          lastSyncStatus: 'success',
        },
      ],
    });
    const sources = svc.listDataSources('u1');
    expect(sources).toEqual([
      {
        id: 'gmail',
        enabled: true,
        lastSyncStatus: 'success',
        lastSyncAt: '2024-01-01T00:00:00Z',
      },
    ]);
  });

  it('tools() lists every registered tool with its permission scope', () => {
    const { svc } = build();
    const tools = svc.tools();
    expect(tools.find((t) => t.name === 'attend')?.permission).toBe('agent:enact-motor');
    expect(tools.find((t) => t.name === 'list-data-sources')?.permission).toBeNull();
  });

  it('unsafeBypassPermissions runs every action regardless of grants', async () => {
    const actions: CortexAction[] = [
      { kind: 'attend', query: 'cortex', reason: 'x' },
    ];
    const { svc, attention } = build({ actions });
    const report = await svc.run('u1', { unsafeBypassPermissions: true });
    expect(attention.focus).toHaveBeenCalled();
    expect(report.blocked).toHaveLength(0);
  });
});
