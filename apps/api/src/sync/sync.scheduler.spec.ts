import type Redis from 'ioredis';
import type { ConnectorConfig, ConnectorId } from '@pkg/shared';
import { resetEnvCache } from '../config/env';
import type { ConnectorConfigStore } from '../connectors/connector-config.store';
import type { SyncOrchestrator } from './sync.orchestrator';

// ── BullMQ mock ──────────────────────────────────────────────────────────
// One fake Queue/Worker pair per queue name; the test reaches into the captured
// instances to assert what the scheduler registered and to drive the worker
// processor by hand (NO real Redis).

interface FakeQueue {
  name: string;
  add: jest.Mock;
  upsertJobScheduler: jest.Mock;
  removeJobScheduler: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
}

interface FakeWorker {
  name: string;
  processor: (job: { data: unknown }) => unknown;
  close: jest.Mock;
  on: jest.Mock;
}

const fakeQueues: FakeQueue[] = [];
const fakeWorkers: FakeWorker[] = [];

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string) => {
    const q: FakeQueue = {
      name,
      add: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    fakeQueues.push(q);
    return q;
  }),
  Worker: jest
    .fn()
    .mockImplementation(
      (name: string, processor: (job: { data: unknown }) => unknown) => {
        const w: FakeWorker = {
          name,
          processor,
          close: jest.fn().mockResolvedValue(undefined),
          on: jest.fn(),
        };
        fakeWorkers.push(w);
        return w;
      },
    ),
}));

// Imported after the mock so the SUT picks up the fakes.
import { SyncScheduler } from './sync.scheduler';

function seedEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.API_PORT = '3001';
  process.env.API_HOST = '0.0.0.0';
  process.env.POSTGRES_URL = 'postgresql://pkg:pkg@localhost:5432/pkg';
  process.env.NEO4J_URI = 'bolt://localhost:7687';
  process.env.NEO4J_USER = 'neo4j';
  process.env.NEO4J_PASSWORD = 'password';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MEILI_HOST = 'http://localhost:7700';
  process.env.MEILI_MASTER_KEY = 'key';
  process.env.JWT_SECRET = 'x'.repeat(32);
  process.env.KEK_BASE64 = Buffer.alloc(32).toString('base64');
}

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'github' as ConnectorId,
    userId: 'user-1',
    enabled: true,
    syncIntervalMinutes: 30,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' },
    ...overrides,
  } as ConnectorConfig;
}

function makeStore(
  initial: ConnectorConfig[] = [],
): jest.Mocked<ConnectorConfigStore> & { fire: (c: ConnectorConfig) => void } {
  const map = new Map<string, ConnectorConfig>();
  for (const c of initial) map.set(`${c.userId}|${c.id}`, c);
  let listener: ((c: ConnectorConfig) => void) | undefined;
  const store = {
    find: jest.fn((userId: string, id: ConnectorId) =>
      map.get(`${userId}|${id}`),
    ),
    all: jest.fn(() => map.values()),
    subscribe: jest.fn((fn: (c: ConnectorConfig) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    }),
  } as unknown as jest.Mocked<ConnectorConfigStore> & {
    fire: (c: ConnectorConfig) => void;
  };
  store.fire = (c: ConnectorConfig) => {
    map.set(`${c.userId}|${c.id}`, c);
    listener?.(c);
  };
  return store;
}

function makeOrchestrator(): jest.Mocked<SyncOrchestrator> {
  return {
    enqueue: jest.fn().mockReturnValue('job-1'),
  } as unknown as jest.Mocked<SyncOrchestrator>;
}

function makeRedis(pingOk = true): jest.Mocked<Redis> {
  return {
    ping: jest.fn(pingOk
      ? () => Promise.resolve('PONG')
      : () => Promise.reject(new Error('ECONNREFUSED'))),
  } as unknown as jest.Mocked<Redis>;
}

describe('SyncScheduler', () => {
  beforeEach(() => {
    fakeQueues.length = 0;
    fakeWorkers.length = 0;
    seedEnv();
    resetEnvCache();
  });

  afterEach(() => {
    resetEnvCache();
    jest.clearAllMocks();
  });

  describe('with Redis available (BullMQ path)', () => {
    it('registers a job scheduler per enabled connector on init', async () => {
      const store = makeStore([makeConfig()]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(true));

      await scheduler.onModuleInit();

      expect(fakeQueues).toHaveLength(1);
      expect(fakeQueues[0].name).toBe('sync:github');
      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenCalledWith(
        'user-1|github',
        { every: 30 * 60_000 },
        expect.objectContaining({
          name: 'sync',
          data: { userId: 'user-1', connectorId: 'github' },
        }),
      );
      await scheduler.onModuleDestroy();
    });

    it('does not use in-process timers when on the BullMQ path', async () => {
      const setInterval = jest.spyOn(global, 'setInterval');
      const store = makeStore([makeConfig()]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(true));

      await scheduler.onModuleInit();

      expect(setInterval).not.toHaveBeenCalled();
      setInterval.mockRestore();
      await scheduler.onModuleDestroy();
    });

    it('kicks off an immediate sync via a one-off queued job (coordinated, not a local enqueue)', async () => {
      const store = makeStore([makeConfig()]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(true));

      await scheduler.onModuleInit();

      // The immediate kick rides the queue (deduped to one across instances by a
      // deterministic jobId), NOT a direct local orchestrator.enqueue.
      expect(orch.enqueue).not.toHaveBeenCalled();
      expect(fakeQueues[0].add).toHaveBeenCalledWith(
        'sync',
        { userId: 'user-1', connectorId: 'github' },
        expect.objectContaining({ jobId: 'kick:user-1|github' }),
      );
      await scheduler.onModuleDestroy();
    });

    it('does not re-kick an immediate sync when only the interval changes', async () => {
      const store = makeStore([makeConfig({ syncIntervalMinutes: 30 })]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(true));
      await scheduler.onModuleInit();
      expect(fakeQueues[0].add).toHaveBeenCalledTimes(1);

      store.fire(makeConfig({ syncIntervalMinutes: 60 }));
      await flush();

      // Re-schedule with a new cadence re-upserts the scheduler but must not
      // fire another immediate one-off kick.
      expect(fakeQueues[0].add).toHaveBeenCalledTimes(1);
      await scheduler.onModuleDestroy();
    });

    it('schedules a newly upserted connector without restart', async () => {
      const store = makeStore();
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(true));
      await scheduler.onModuleInit();
      expect(fakeQueues).toHaveLength(0);

      store.fire(makeConfig({ id: 'gmail' as ConnectorId }));
      await flush();

      expect(fakeQueues).toHaveLength(1);
      expect(fakeQueues[0].name).toBe('sync:gmail');
      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenCalled();
      await scheduler.onModuleDestroy();
    });

    it('removes the job scheduler when a connector is disabled', async () => {
      const store = makeStore([makeConfig()]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(true));
      await scheduler.onModuleInit();

      store.fire(makeConfig({ enabled: false }));
      await flush();

      expect(fakeQueues[0].removeJobScheduler).toHaveBeenCalledWith('user-1|github');
      await scheduler.onModuleDestroy();
    });

    it('re-registers the scheduler when the interval changes', async () => {
      const store = makeStore([makeConfig({ syncIntervalMinutes: 30 })]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(true));
      await scheduler.onModuleInit();
      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenCalledTimes(1);

      store.fire(makeConfig({ syncIntervalMinutes: 60 }));
      await flush();

      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenLastCalledWith(
        'user-1|github',
        { every: 60 * 60_000 },
        expect.anything(),
      );
      await scheduler.onModuleDestroy();
    });

    it('skips a redundant re-register when the interval is unchanged', async () => {
      const store = makeStore([makeConfig({ syncIntervalMinutes: 30 })]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(true));
      await scheduler.onModuleInit();

      store.fire(makeConfig({ syncIntervalMinutes: 30 }));
      await flush();

      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenCalledTimes(1);
      await scheduler.onModuleDestroy();
    });

    it('clamps sub-minute intervals to the 1-minute floor', async () => {
      const store = makeStore([makeConfig({ syncIntervalMinutes: 0 })]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(true));
      await scheduler.onModuleInit();

      expect(fakeQueues[0].upsertJobScheduler).toHaveBeenCalledWith(
        'user-1|github',
        { every: 60_000 },
        expect.anything(),
      );
      await scheduler.onModuleDestroy();
    });

    it('enqueues through the orchestrator when a scheduled job fires', async () => {
      const store = makeStore([makeConfig()]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(true));
      await scheduler.onModuleInit();
      orch.enqueue.mockClear();

      // Drive the worker processor as BullMQ would on each repeat tick.
      await fakeWorkers[0].processor({
        data: { userId: 'user-1', connectorId: 'github' },
      });

      expect(orch.enqueue).toHaveBeenCalledWith({
        userId: 'user-1',
        connectorId: 'github',
      });
      await scheduler.onModuleDestroy();
    });

    it('a fired job does not enqueue when the connector was disabled meanwhile', async () => {
      const store = makeStore([makeConfig()]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(true));
      await scheduler.onModuleInit();
      orch.enqueue.mockClear();
      store.fire(makeConfig({ enabled: false }));
      await flush();
      orch.enqueue.mockClear();

      await fakeWorkers[0].processor({
        data: { userId: 'user-1', connectorId: 'github' },
      });

      expect(orch.enqueue).not.toHaveBeenCalled();
      await scheduler.onModuleDestroy();
    });

    it('closes workers and queues on shutdown', async () => {
      const store = makeStore([makeConfig()]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(true));
      await scheduler.onModuleInit();

      await scheduler.onModuleDestroy();

      expect(fakeWorkers[0].close).toHaveBeenCalled();
      expect(fakeQueues[0].close).toHaveBeenCalled();
    });
  });

  describe('with Redis unavailable (in-process fallback)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('falls back to setInterval and never touches BullMQ', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const store = makeStore([makeConfig()]);
      const scheduler = new SyncScheduler(store, makeOrchestrator(), makeRedis(false));

      await scheduler.onModuleInit();

      expect(fakeQueues).toHaveLength(0);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      await scheduler.onModuleDestroy();
    });

    it('fires the orchestrator immediately and on each interval tick', async () => {
      const store = makeStore([makeConfig({ syncIntervalMinutes: 1 })]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(false));

      await scheduler.onModuleInit();
      expect(orch.enqueue).toHaveBeenCalledTimes(1); // immediate kick

      jest.advanceTimersByTime(60_000);
      expect(orch.enqueue).toHaveBeenCalledTimes(2); // first interval tick

      jest.advanceTimersByTime(60_000);
      expect(orch.enqueue).toHaveBeenCalledTimes(3);
      await scheduler.onModuleDestroy();
    });

    it('clears the timer when a connector is disabled', async () => {
      const clearSpy = jest.spyOn(global, 'clearInterval');
      const store = makeStore([makeConfig({ syncIntervalMinutes: 1 })]);
      const orch = makeOrchestrator();
      const scheduler = new SyncScheduler(store, orch, makeRedis(false));
      await scheduler.onModuleInit();
      orch.enqueue.mockClear();

      store.fire(makeConfig({ enabled: false, syncIntervalMinutes: 1 }));
      await flushMicrotasks();

      expect(clearSpy).toHaveBeenCalled();
      jest.advanceTimersByTime(120_000);
      expect(orch.enqueue).not.toHaveBeenCalled();
      await scheduler.onModuleDestroy();
    });
  });
});

/** Flush pending promises (real timers). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Flush microtasks under fake timers (no macrotask needed). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
