import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/database.js';
import { attachRealtime } from './modules/realtime/realtime.js';
import { startReminderJob } from './jobs/reminder.job.js';
import { startPushJob } from './jobs/push.job.js';
import { closeRedis } from './config/redis.js';
import { healthService } from './modules/health/health.service.js';
import { logger } from './config/logger.js';

const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'M3allem API listening'));
const realtime=attachRealtime(server);
const stopReminderJob=startReminderJob();
const stopPushJob=startPushJob();
server.requestTimeout = env.REQUEST_TIMEOUT_MS;
server.headersTimeout = env.REQUEST_TIMEOUT_MS+5_000;
server.keepAliveTimeout = 5_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  healthService.markDraining();
  logger.info({ signal }, 'API shutdown started');
  const deadline=setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);deadline.unref();
  try {
    // Stop new claims immediately and drain current work before closing the DB.
    const jobs=Promise.all([stopReminderJob(),stopPushJob()]);
    for(const socket of realtime.clients)socket.terminate();
    await Promise.all([jobs,new Promise(resolve=>realtime.close(resolve)),new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))]);
    await closeRedis();
    await prisma.$disconnect();
    clearTimeout(deadline);
    process.exit(0);
  } catch(error) {
    logger.error({code:error.code??'SHUTDOWN_FAILED'},'API shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
