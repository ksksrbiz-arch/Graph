import type Redis from 'ioredis';
import { ConflictException } from '@nestjs/common';
import { resetEnvCache } from '../config/env';
import { BrainRuntimeService } from './brain-runtime.service';
import type { BrainService } from './brain.service';
import type { DreamService } from './dream.service';

describe('BrainRuntimeService', () => {
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
    process.env.BRAIN_AUTO_START_USER_IDS = 'user-auto';
    process.env.BRAIN_AUTO_START_DREAM = 'true';
    process.env.BRAIN_DEFAULT_AWAKE_MS = '1000';
    process.env.BRAIN_DEFAULT_DREAM_MS = '1000';
    process.env.BRAIN_LOCK_TTL_SECONDS = '60';
  }

  function makeBrain(): jest.Mocked<BrainService> {
    return {
      isRunning: jest.fn().mockReturnValue(false),
      start: jest.fn().mockResolvedValue({ neurons: 2, synapses: 1 }),
      stop: jest.fn().mockReturnValue(true),
      checkpoint: jest.fn().mockResolvedValue({ persisted: 0, skipped: 0 }),
      summary: jest.fn().mockReturnValue({ neurons: 2, synapses: 1 }),
    } as unknown as jest.Mocked<BrainService>;
  }

  function makeDream(): jest.Mocked<DreamService> {
    return {
      start: jest.fn().mockReturnValue({
        userId: 'user-auto',
        phase: 'awake',
        cycleStartedAt: 0,
        cycleEndsAt: 1,
        awakeMs: 1000,
        dreamMs: 1000,
        recentSpikes: 0,
      }),
      stop: jest.fn().mockReturnValue(true),
      status: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<DreamService>;
  }

  function makeRedis(initial: Record<string, string> = {}): jest.Mocked<Redis> {
    const store = new Map(Object.entries(initial));
    return {
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      eval: jest.fn().mockImplementation(async (script: string, _keys: number, key: string, value: string) => {
        if (script.includes('DEL')) {
          if (store.get(key) === value) {
            store.delete(key);
            return 1;
          }
          return 0;
        }
        if (store.get(key) === value) return 1;
        return 0;
      }),
    } as unknown as jest.Mocked<Redis>;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    seedEnv();
    resetEnvCache();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetEnvCache();
    delete process.env.BRAIN_AUTO_START_USER_IDS;
    delete process.env.BRAIN_AUTO_START_DREAM;
    delete process.env.BRAIN_DEFAULT_AWAKE_MS;
    delete process.env.BRAIN_DEFAULT_DREAM_MS;
    delete process.env.BRAIN_LOCK_TTL_SECONDS;
  });

  it('auto-starts configured brains on bootstrap and starts dream cycling', async () => {
    const brain = makeBrain();
    const dream = makeDream();
    const redis = makeRedis();
    const service = new BrainRuntimeService(brain, dream, redis);

    await service.onApplicationBootstrap();

    expect(brain.start).toHaveBeenCalledWith('user-auto');
    expect(dream.start).toHaveBeenCalledWith('user-auto', { awakeMs: 1000, dreamMs: 1000 });
    await service.onModuleDestroy();
  });

  it('rejects start when another instance already owns the brain lock', async () => {
    const service = new BrainRuntimeService(
      makeBrain(),
      makeDream(),
      makeRedis({ 'brain:owner:user-1': 'remote-instance' }),
    );

    await expect(service.start('user-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports remote ownership in runtime status', async () => {
    const service = new BrainRuntimeService(
      makeBrain(),
      makeDream(),
      makeRedis({ 'brain:owner:user-1': 'remote-instance' }),
    );

    await expect(service.status('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      running: true,
      runningLocally: false,
      ownedByThisInstance: false,
      ownerInstanceId: 'remote-instance',
    });
  });
});
