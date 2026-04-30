// Socket.IO gateway for the /graph namespace — broadcasts GraphDeltaEvent
// payloads so connected SPA clients update their canvas in real time without
// polling (spec §6.3 / Phase 2 DoD).
//
// Each client connects with ?userId=<uuid> and is joined to the user-scoped
// room `graph:<userId>`. Delta events from any write path (sync, public-ingest,
// manual API) are routed here via GraphService.emitDelta().
//
// Event: `graph:delta`  payload: GraphDeltaEvent (from @pkg/shared)

import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { GraphDeltaEvent } from '@pkg/shared';

@WebSocketGateway({
  namespace: '/graph',
  cors: { origin: true, credentials: true },
})
export class GraphGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(GraphGateway.name);
  @WebSocketServer() server!: Server;

  /** Broadcast a delta event to all sockets connected for `userId`. */
  emitDelta(userId: string, event: GraphDeltaEvent): void {
    this.server?.to(roomFor(userId)).emit('graph:delta', event);
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
    this.log.debug(`graph client connected user=${userId} sid=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.log.debug(`graph client disconnected sid=${client.id}`);
  }
}

function roomFor(userId: string): string {
  return `graph:${userId}`;
}

function extractUserId(client: Socket): string | null {
  const fromQuery = client.handshake.query.userId;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') {
    return fromQuery[0];
  }
  return null;
}
