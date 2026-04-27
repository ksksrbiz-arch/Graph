import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { WeightChangeEvent } from '@pkg/spiking';

/** Payloads broadcast on the /brain namespace. */
export interface BrainSpike {
  neuronId: string;
  region: string;
  outgoing: string[];
  t: number;
}
export interface BrainTick {
  t: number;
  spikeCount: number;
  meanRate: number;
}

@WebSocketGateway({
  namespace: '/brain',
  cors: { origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','), credentials: true },
})
export class BrainGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BrainGateway.name);
  @WebSocketServer() server!: Server;

  handleConnection(client: Socket): void {
    // Clients connect with `?userId=<uuid>` — we drop them into a per-user room
    // so events for one user don't broadcast to every browser tab.
    const userId = (client.handshake.query.userId as string | undefined) ?? 'demo';
    void client.join(`brain:${userId}`);
    this.logger.debug(`client ${client.id} → brain:${userId}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`client disconnected: ${client.id}`);
  }

  emitSpike(userId: string, evt: BrainSpike): void {
    this.server.to(`brain:${userId}`).emit('spike', evt);
  }
  emitWeightChange(userId: string, evt: WeightChangeEvent): void {
    this.server.to(`brain:${userId}`).emit('weight-change', evt);
  }
  emitTick(userId: string, evt: BrainTick): void {
    this.server.to(`brain:${userId}`).emit('tick', evt);
  }
}
