import { notificationRepository } from './notification.repository.js';
import { pushProvider } from './push.provider.js';
import { logger } from '../../config/logger.js';

const invalidTokens = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const permanentErrors = new Set(['messaging/invalid-argument', 'messaging/invalid-payload', 'messaging/payload-size-limit-exceeded',
  'messaging/invalid-options', ...invalidTokens]);
function failure(error, attempts, random) {
  const raw = String(error?.code ?? 'PUSH_PROVIDER_ERROR');
  const code = /^[A-Za-z0-9_./:-]{1,120}$/.test(raw) ? raw : 'PUSH_PROVIDER_ERROR';
  return { code, permanent: permanentErrors.has(code), invalidDevice: invalidTokens.has(code),
    delaySeconds: Math.max(1, Math.round(Math.min(3600, 30 * 2 ** (attempts - 1)) * (0.8 + random() * 0.4))) };
}
function bounded(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Push provider timeout'), { code: 'PUSH_TIMEOUT' })), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}
export function pushMessage(row) {
  const data = { notificationId: String(row.id), type: row.type, title: row.title, body: row.body };
  for (const key of ['requestId', 'conversationId', 'workerId', 'reminderId']) if (row[key] != null) data[key] = String(row[key]);
  if (row.scheduledAt) data.scheduledAt = String(row.scheduledAt.getTime());
  return { token: row.deviceToken, data, android: { ttl: row.scheduledAt
    ? Math.max(0, Math.min(3600000, row.scheduledAt.getTime() - Date.now())) : 3600000 } };
}

export function createNotificationWorker({ repository = notificationRepository, provider = pushProvider, random = Math.random,
  timeoutMs = 25000, concurrency = 4, limit = 100, log = logger } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError('Invalid worker bounds');
  return {
    async runOnce({ shouldStop = () => false } = {}) {
      if (shouldStop()) return { claimed: 0, sent: 0, failed: 0 };
      // Credentials/provider readiness is outside database transactions/claims.
      if (provider.ready) await bounded(() => provider.ready(), timeoutMs);
      const result = { claimed: 0, sent: 0, failed: 0 };
      let reserved = 0, failedLane = false;
      const lane = async () => {
        try { while (!shouldStop() && !failedLane && reserved < limit) {
          reserved++;
          const claim = await repository.claimOne();
          if (!claim) return;
          result.claimed++;
          if (claim.exhausted) { result.failed++; continue; }
          if (shouldStop()) {
            await repository.failed(claim, { code: 'WORKER_STOPPED', permanent: false, invalidDevice: false, delaySeconds: 1 });
            return;
          }
          const row = await repository.prepareAttempt(claim);
          if (!row) continue;
          let messageId;
          try {
            messageId = await bounded(() => provider.send(pushMessage(row)), timeoutMs);
            if (typeof messageId !== 'string' || !messageId.trim()) throw Object.assign(new Error('Invalid provider response'), { code: 'PUSH_INVALID_RESPONSE' });
          } catch (error) {
            const outcome = failure(error, claim.attempts, random);
            await repository.failed(claim, outcome);
            result.failed++;
            log.warn({ deliveryId: String(claim.id), code: outcome.code }, 'Push attempt failed');
            continue;
          }
          // A database acknowledgement failure is not a provider failure: leave
          // the lease for recovery instead of classifying the accepted send.
          if (await repository.sent(claim, messageId)) result.sent++;
        } } catch (error) { failedLane = true; throw error; }
      };
      const lanes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, limit) }, lane));
      const rejected = lanes.find((entry) => entry.status === 'rejected');
      if (rejected) throw rejected.reason;
      return result;
    }
  };
}
