import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env';
import { splitCsvEnv } from '../config/env-utils';
import { REDIS_CLIENT } from '../shared/redis/redis.module';
import { BrainService } from './brain.service';
import type { DreamStatus } from './dream.service';
import { DreamService } from './dream.service';

interface StartOptions {
  startDream?: boolean;
  suppressRemoteConflict?: boolean;
}

export interface BrainRuntimeStatus {
  userId: string;
  running: boolean;
  runningLocally: boolean;
  ownedByThisInstance: boolean;
  ownerInstanceId: string | null;
  autoStartConfigured: boolean;
  summary: { neurons: number; synapses: number } | null;
  dream: DreamStatus | null;
}

const RENEW_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class BrainRuntimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(BrainRuntimeService.name);
  private readonly env = loadEnv();
  private readonly instanceId = randomUUID();
  private readonly autoStartUsers = new Set(splitCsvEnv(this.env.BRAIN_AUTO_START_USER_IDS));
  private readonly ownedLocks = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly brain: BrainService,
    private readonly dream: DreamService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const userId of this.autoStartUsers) {
      try {
        const summary = await this.start(userId, {
          startDream: this.env.BRAIN_AUTO_START_DREAM,
          suppressRemoteConflict: true,
        });
        if (summary) {
          this.log.log(
            `auto-started brain user=${userId} neurons=${summary.neurons} synapses=${summary.synapses}`,
          );
        }
      } catch (error) {
        this.log.warn(`auto-start failed user=${userId}: ${(error as Error).message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const userId of [...this.ownedLocks.keys()]) {
      await this.stop(userId);
    }
  }

  async start(
    userId: string,
    options: StartOptions = {},
  ): Promise<{ neurons: number; synapses: number } | null> {
    if (this.brain.isRunning(userId)) {
      if (options.startDream && !this.dream.status(userId)) {
        this.startDreamCycle(userId);
      }
      return this.brain.summary(userId);
    }

    const claimed = await this.claimLock(userId);
    if (!claimed) {
      if (options.suppressRemoteConflict) return null;
      throw new ConflictException(`brain is already running on another instance for user=${userId}`);
    }

    try {
      const summary = await this.brain.start(userId);
      if (options.startDream) this.startDreamCycle(userId);
      return summary;
    } catch (error) {
      await this.releaseLock(userId);
      throw error;
    }
  }

  async stop(userId: string): Promise<boolean> {
    this.dream.stop(userId);
    const stopped = this.brain.stop(userId);
    await this.releaseLock(userId);
    return stopped;
  }

  checkpoint(userId: string): Promise<{ persisted: number; skipped: number }> {
    return this.brain.checkpoint(userId);
  }

  async status(userId: string): Promise<BrainRuntimeStatus> {
    const ownerInstanceId = await this.redis.get(this.lockKey(userId));
    return {
      userId,
      running: this.brain.isRunning(userId) || ownerInstanceId !== null,
      runningLocally: this.brain.isRunning(userId),
      ownedByThisInstance: ownerInstanceId === this.instanceId,
      ownerInstanceId,
      autoStartConfigured: this.autoStartUsers.has(userId),
      summary: this.brain.summary(userId),
      dream: this.dream.status(userId),
    };
  }

  private async claimLock(userId: string): Promise<boolean> {
    const claimed = await this.redis.set(
      this.lockKey(userId),
      this.instanceId,
      'EX',
      this.env.BRAIN_LOCK_TTL_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') return false;
    this.startRenewTimer(userId);
    return true;
  }

  private startRenewTimer(userId: string): void {
    this.stopRenewTimer(userId);
    const delayMs = Math.max(5_000, Math.floor((this.env.BRAIN_LOCK_TTL_SECONDS * 1_000) / 3));
    const timer = setInterval(() => {
      void this.renewLock(userId);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.ownedLocks.set(userId, timer);
  }

  private stopRenewTimer(userId: string): void {
    const timer = this.ownedLocks.get(userId);
    if (!timer) return;
    clearInterval(timer);
    this.ownedLocks.delete(userId);
  }

  private async renewLock(userId: string): Promise<void> {
    const renewed = Number(
      await this.redis.eval(
        RENEW_LOCK_SCRIPT,
        1,
        this.lockKey(userId),
        this.instanceId,
        String(this.env.BRAIN_LOCK_TTL_SECONDS),
      ),
    );
    if (renewed === 1) return;

    this.log.warn(`lost brain lock for user=${userId}; stopping local runtime`);
    this.stopRenewTimer(userId);
    this.dream.stop(userId);
    this.brain.stop(userId);
  }

  private async releaseLock(userId: string): Promise<void> {
    this.stopRenewTimer(userId);
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.lockKey(userId), this.instanceId);
  }

  private startDreamCycle(userId: string): void {
    this.dream.start(userId, {
      awakeMs: this.env.BRAIN_DEFAULT_AWAKE_MS,
      dreamMs: this.env.BRAIN_DEFAULT_DREAM_MS,
    });
  }

  private lockKey(userId: string): string {
    return `brain:owner:${userId}`;
  }
}
