import { env } from '../config/env.js';
import { createNotificationWorker } from '../modules/notifications/notification.service.js';
import { startRecurringJob } from './recurring-job.js';

export const startPushJob = ({ enabled = env.PUSH_DELIVERY_ENABLED ?? env.APP_ENV === 'production', worker = createNotificationWorker() } = {}) => {
  if (!enabled) return async () => {};
  return startRecurringJob({ name: 'push-delivery', intervalMs: 10000, run: (control) => worker.runOnce(control) });
};
