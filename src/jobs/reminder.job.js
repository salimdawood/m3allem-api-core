import { reminderRepository } from './reminder.repository.js';
import { realtimeHub } from '../modules/realtime/hub.js';
import { startRecurringJob } from './recurring-job.js';
import { logger } from '../config/logger.js';

export async function runReminderCycle({ repository = reminderRepository, publish = (row) => realtimeHub.publish(row.recipientUserId, 'notification.created', row),
  shouldStop = () => false, limit = 100 } = {}) {
  let created = 0;
  for (const row of await repository.candidates(limit)) {
    if (shouldStop()) break;
    try {
      const notification = await repository.materialize(row);
      if (notification) { created++; await publish(notification); }
    } catch (error) {
      // A bad/stale candidate must not block the rest of the bounded batch.
      logger.error({ code: error.meta?.code ?? error.code ?? 'REMINDER_FAILED', reminderId: String(row.id) }, 'Reminder materialization failed');
    }
  }
  return { created };
}
export const startReminderJob = () => startRecurringJob({ name: 'reminders', intervalMs: 30000, run: runReminderCycle });
