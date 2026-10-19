import { WebSocketServer } from 'ws';
import { accessIdentity } from '../../middlewares/auth.js';
import { authRepository } from '../auth/auth.repository.js';
import { realtimeHub } from './hub.js';

export const attachRealtime = (server) => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', async (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/v1/realtime') { socket.destroy(); return; }
    try {
      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) throw new Error('Missing bearer token');
      const identity = await accessIdentity(token);
      wss.handleUpgrade(req, socket, head, (ws) => {
        realtimeHub.add(identity.id, ws, identity.sessionId);
        ws.send(JSON.stringify({ event: 'connected', data: { userId: identity.id } }));
        const expiry = setTimeout(() => ws.close(4401, 'Access token expired'), Math.max(0, identity.expiresAt - Date.now()));
        const check = setInterval(async () => {
          try { if (!await authRepository.sessionIdentity(identity.id, identity.sessionId)) ws.close(4401, 'Session unavailable'); }
          catch { ws.close(1011, 'Session check failed'); }
        }, 15_000);
        ws.on('close', () => { clearTimeout(expiry); clearInterval(check); });
        ws.on('message', () => ws.close(1008, 'Client messages are not supported'));
      });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  return wss;
};
