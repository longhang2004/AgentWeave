import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { socketIoCorsOrigin } from './local-origin';

// Post-PP1 hardening: the WebSocket boundary shares the HTTP local-origin
// policy — explicit bounded allow-list via CORS_ORIGIN, loopback browser
// origins by default, wildcard "*" rejected (never reaches Socket.IO).
@WebSocketGateway({
  cors: {
    origin: socketIoCorsOrigin(process.env.CORS_ORIGIN),
    credentials: true,
  },
})
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`WebSocket client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`WebSocket client disconnected: ${client.id}`);
  }

  broadcastExecutionUpdate(executionId: string, data: any) {
    console.log(`Broadcasting execution update event for: ${executionId}`);
    this.server.emit('execution-update', {
      executionId,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}
