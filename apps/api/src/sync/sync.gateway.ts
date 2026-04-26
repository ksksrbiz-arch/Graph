// /sync namespace — broadcasts SyncProgressEvent (spec §6.3) so the SPA can
// render live progress bars while a connector runs. Each socket joins a room
// keyed by userId; one user's syncs never reach another's clients.

import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { SyncProgressEvent } from '@pkg/shared';
import type { SyncJobResult } from './sync.types';

@WebSocketGateway({
  namespace: '/sync',
  cors: { origin: true, credentials: true },
})
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(SyncGateway.name);
  @WebSocketServer() server!: Server;

  emitProgress(userId: string, evt: SyncProgressEvent): void {
    this.server?.to(roomFor(userId)).emit('progress', evt);
  }

  emitResult(userId: string, result: SyncJobResult): void {
    this.server?.to(roomFor(userId)).emit('result', result);
  }

  handleConnection(client: Socket): void {
    const userId = extractUserId(client);
    if (!userId) {
      client.emit('error', { message: 'missing userId query parameter' });
      client.disconnect(true);
      return;
    }
    client.join(roomFor(userId));
    client.data.userId = userId;
    this.log.debug(`sync client connected user=${userId} sid=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.log.debug(`sync client disconnected sid=${client.id}`);
  }
}

function roomFor(userId: string): string {
  return `sync:${userId}`;
}

function extractUserId(client: Socket): string | null {
  const fromQuery = client.handshake.query.userId;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') {
    return fromQuery[0];
  }
  return null;
}
