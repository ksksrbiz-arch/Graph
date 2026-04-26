// Socket.IO gateway that broadcasts spike + weight-change events to web
// clients. Each client connects with `?userId=<uuid>` and is automatically
// joined to that user's brain room; events for other users never reach them.
//
// Event shapes (kept terse since spikes can be high-frequency):
//   spike   → { i: neuronId, t: tMs, r?: region }
//   weight  → { i: synapseId, p: pre, q: post, w: weight, d: delta, t: tMs }
//   dream   → { phase, endsAt, replayCount } — wake/sleep transitions

import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { BrainService } from './brain.service';

export interface DreamEvt {
  phase: 'awake' | 'sleeping' | 'rem';
  endsAt: number;
  replayCount: number;
}

@WebSocketGateway({
  namespace: '/brain',
  cors: { origin: true, credentials: true },
})
export class BrainGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly log = new Logger(BrainGateway.name);
  @WebSocketServer() server!: Server;

  constructor(private readonly brain: BrainService) {}

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
  }

  handleConnection(client: Socket): void {
    const userId = this.extractUserId(client);
    if (!userId) {
      client.emit('error', { message: 'missing userId query parameter' });
      client.disconnect(true);
      return;
    }
    client.join(this.roomFor(userId));
    client.data.userId = userId;
    client.emit('hello', {
      userId,
      running: this.brain.isRunning(userId),
    });
    this.log.debug(`client connected user=${userId} sid=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
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
