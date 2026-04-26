// Socket.IO gateway that broadcasts spike + weight-change events to web
// clients. Each client connects with `?userId=<uuid>` and is automatically
// joined to that user's brain room; events for other users never reach them.
//
// Event shapes (kept terse since spikes can be high-frequency):
//   spike       → { i: neuronId, t: tMs, r?: region }
//   weight      → { i: synapseId, p: pre, q: post, w: weight, d: delta, t: tMs }
//   dream       → { phase, endsAt, replayCount } — wake/sleep transitions
//   pathway     → { i, p, q, w, formedAt } — synapse crossed the formation threshold
//   insight     → BrainInsightsSummary — periodic dashboard heartbeat (every 5s)

import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { loadEnv } from '../config/env';
import { splitCsvEnv } from '../config/env-utils';
import { BrainService } from './brain.service';
import { InsightsService } from './insights.service';

export interface DreamEvt {
  phase: 'awake' | 'sleeping' | 'rem';
  endsAt: number;
  replayCount: number;
}

const INSIGHT_PUSH_INTERVAL_MS = 5_000;

@WebSocketGateway({
  namespace: '/brain',
  cors: { origin: true, credentials: true },
})
export class BrainGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(BrainGateway.name);
  private readonly allowedOrigins = splitCsvEnv(loadEnv().CORS_ORIGINS);
  @WebSocketServer() server!: Server;
  private insightTimer?: NodeJS.Timeout;
  /** Set of userIds with at least one connected client — drives the insight
   *  push loop, so we don't compute summaries for users nobody is watching. */
  private readonly watchedUsers = new Map<string, number>();

  constructor(
    private readonly brain: BrainService,
    private readonly insights: InsightsService,
  ) {}

  emitDream(userId: string, evt: DreamEvt): void {
    this.server?.to(this.roomFor(userId)).emit('dream', evt);
  }

  onModuleInit(): void {
    this.brain.subscribeSpikes((userId, e) => {
      this.server?.to(this.roomFor(userId)).emit('spike', {
        i: e.neuronId,
        t: e.tMs,
        ...(e.region ? { r: e.region } : {}),
      });
    });
    this.brain.subscribeWeights((userId, e) => {
      this.server?.to(this.roomFor(userId)).emit('weight', {
        i: e.synapseId,
        p: e.pre,
        q: e.post,
        w: e.weight,
        d: e.delta,
        t: e.tMs,
      });
    });
    this.insights.onFormation((userId, e) => {
      this.server?.to(this.roomFor(userId)).emit('pathway', {
        i: e.synapseId,
        p: e.pre,
        q: e.post,
        w: e.weight,
        formedAt: e.formedAt,
      });
    });

    this.insightTimer = setInterval(() => this.pushInsights(), INSIGHT_PUSH_INTERVAL_MS);
    if (typeof this.insightTimer.unref === 'function') {
      this.insightTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.insightTimer) clearInterval(this.insightTimer);
  }

  private pushInsights(): void {
    if (!this.server) return;
    for (const userId of this.watchedUsers.keys()) {
      const summary = this.insights.summary(userId);
      this.server.to(this.roomFor(userId)).emit('insight', summary);
    }
  }

  handleConnection(client: Socket): void {
    const origin = client.handshake.headers.origin;
    if (
      typeof origin === 'string' &&
      this.allowedOrigins.length > 0 &&
      !this.allowedOrigins.includes(origin)
    ) {
      client.emit('error', { message: 'origin not allowed' });
      client.disconnect(true);
      return;
    }
    const userId = this.extractUserId(client);
    if (!userId) {
      client.emit('error', { message: 'missing userId query parameter' });
      client.disconnect(true);
      return;
    }
    client.join(this.roomFor(userId));
    client.data.userId = userId;
    this.watchedUsers.set(userId, (this.watchedUsers.get(userId) ?? 0) + 1);
    client.emit('hello', {
      userId,
      running: this.brain.isRunning(userId),
    });
    // Send the current insights summary right away so the SPA can hydrate
    // its dashboard without waiting up to INSIGHT_PUSH_INTERVAL_MS.
    client.emit('insight', this.insights.summary(userId));
    this.log.debug(`client connected user=${userId} sid=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data.userId as string | undefined;
    if (userId) {
      const next = (this.watchedUsers.get(userId) ?? 1) - 1;
      if (next <= 0) this.watchedUsers.delete(userId);
      else this.watchedUsers.set(userId, next);
    }
    this.log.debug(`client disconnected sid=${client.id}`);
  }

  private extractUserId(client: Socket): string | null {
    const fromQuery = client.handshake.query.userId;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
    if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') {
      return fromQuery[0];
    }
    return null;
  }

  private roomFor(userId: string): string {
    return `brain:${userId}`;
  }
}
