import { authRepository } from '../auth/auth.repository.js';
import { idNumber, jsonReplacer } from '../../utils/id.js';

const clients = new Map();
export const realtimeHub = {
  add(userId, socket, sessionId) {
    const key = idNumber(userId);
    const set = clients.get(key) ?? new Set();
    socket.authSessionId = idNumber(sessionId);
    set.add(socket);
    clients.set(key, set);
    socket.on('close', () => { set.delete(socket); if (!set.size) clients.delete(key); });
  },
  disconnect(userId, sessionId) {
    for (const socket of clients.get(idNumber(userId)) ?? []) {
      if (sessionId == null || socket.authSessionId === idNumber(sessionId)) socket.close(4401, 'Session unavailable');
    }
  },
  async publish(userId, event, data) {
    const key = idNumber(userId);
    for (const socket of clients.get(key) ?? []) {
      try {
        if (!await authRepository.sessionIdentity(key, socket.authSessionId)) { socket.close(4401, 'Session unavailable'); continue; }
        if (socket.readyState === 1) socket.send(JSON.stringify({ event, data }, jsonReplacer));
      } catch { socket.close(1011, 'Session check failed'); }
    }
  },
  publishMany(userIds, event, data) { for (const id of new Set(userIds.filter(Boolean).map(idNumber))) void this.publish(id, event, data); }
};
