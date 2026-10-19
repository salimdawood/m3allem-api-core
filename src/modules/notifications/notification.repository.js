import { prisma } from '../../config/database.js';
import { resourceTransaction } from '../../utils/resource-transaction.js';

const validLease = (db, claim) => db.$queryRaw`SELECT id FROM active_notification_deliveries
  WHERE id=${claim.id} AND status='PROCESSING' AND claim_version=${claim.claimVersion}
    AND lease_expires_at>clock_timestamp() FOR UPDATE`;
export const notificationRepository = {
  async claimOne({ leaseSeconds = 90 } = {}) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) throw new RangeError('Invalid delivery lease');
    return resourceTransaction(async (db) => {
      const row = (await db.$queryRaw`SELECT id,attempts,max_attempts AS "maxAttempts" FROM active_notification_deliveries
        WHERE (status='PENDING' AND next_attempt_at<=clock_timestamp())
          OR (status='PROCESSING' AND lease_expires_at<=clock_timestamp())
        ORDER BY COALESCE(next_attempt_at,lease_expires_at),id LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];
      if (!row) return null;
      if (row.attempts >= row.maxAttempts) {
        await db.$executeRaw`UPDATE active_notification_deliveries SET status='FAILED',next_attempt_at=NULL,
          lease_expires_at=NULL,last_error_code='LEASE_EXPIRED' WHERE id=${row.id}`;
        return { id: row.id, exhausted: true };
      }
      return (await db.$queryRaw`UPDATE active_notification_deliveries SET status='PROCESSING',attempts=attempts+1,
        claim_version=claim_version+1,next_attempt_at=NULL,lease_expires_at=clock_timestamp()+make_interval(secs=>${leaseSeconds})
        WHERE id=${row.id} RETURNING id,notification_id AS "notificationId",recipient_user_id AS "recipientUserId",
          device_id AS "deviceId",device_token AS "deviceToken",attempts,max_attempts AS "maxAttempts",claim_version AS "claimVersion"`)[0];
    });
  },
  async prepareAttempt(claim) {
    return resourceTransaction(async (db) => {
      const account = (await db.$queryRaw`SELECT account_status AS status,deleted_at AS "deletedAt" FROM users
        WHERE id=${claim.recipientUserId} FOR SHARE`)[0];
      const settings = (await db.$queryRaw`SELECT notifications_enabled AS enabled,reminder_lead_minutes AS lead
        FROM active_user_settings WHERE user_id=${claim.recipientUserId} FOR SHARE`)[0];
      // Read immutable target IDs first, then lock source parents before inbox/queue.
      const target = (await db.$queryRaw`SELECT type,request_id AS "requestId",reminder_id AS "reminderId"
        FROM active_notifications WHERE id=${claim.notificationId}`)[0];
      let appointment;
      if (target?.type === 'APPOINTMENT_REMINDER') {
        const request = (await db.$queryRaw`SELECT status,scheduled_at AS "scheduledAt",deleted_at AS "deletedAt",
          (scheduled_at>clock_timestamp()) AS future FROM service_requests WHERE id=${target.requestId} FOR SHARE`)[0];
        const reminder = (await db.$queryRaw`SELECT notification_id AS "notificationId",cancelled_at AS "cancelledAt",deleted_at AS "deletedAt"
          FROM scheduled_reminders WHERE id=${target.reminderId} FOR SHARE`)[0];
        appointment = request && !request.deletedAt && request.status === 'ACCEPTED' && request.future && reminder && !reminder.deletedAt &&
          !reminder.cancelledAt && reminder.notificationId === claim.notificationId && settings?.lead !== 0 ? request : null;
      }
      const notification = (await db.$queryRaw`SELECT id,type,title,body,request_id AS "requestId",conversation_id AS "conversationId",
        worker_id AS "workerId",reminder_id AS "reminderId" FROM active_notifications WHERE id=${claim.notificationId} FOR SHARE`)[0];
      const device = (await db.$queryRaw`SELECT id,user_id AS "userId",fcm_token AS token,deleted_at AS "deletedAt"
        FROM devices WHERE id=${claim.deviceId} FOR SHARE`)[0];
      if (!(await validLease(db, claim)).length) return null;
      const eligible = account && !account.deletedAt && account.status === 'ACTIVE' && settings?.enabled !== false && notification &&
        device && !device.deletedAt && device.userId === claim.recipientUserId && device.token === claim.deviceToken &&
        (notification.type !== 'APPOINTMENT_REMINDER' || appointment);
      if (!eligible) {
        await db.$executeRaw`UPDATE active_notification_deliveries SET status='CANCELLED',next_attempt_at=NULL,
          lease_expires_at=NULL,last_error_code='DELIVERY_INELIGIBLE' WHERE id=${claim.id}`;
        return null;
      }
      return { ...notification, deviceToken: device.token, scheduledAt: appointment?.scheduledAt ?? null };
    });
  },
  async sent(claim, providerMessageId) {
    const changed = await prisma.$executeRaw`UPDATE active_notification_deliveries SET status='SENT',next_attempt_at=NULL,
      lease_expires_at=NULL,provider_message_id=${providerMessageId},last_error_code=NULL
      WHERE id=${claim.id} AND status='PROCESSING' AND claim_version=${claim.claimVersion} AND lease_expires_at>clock_timestamp()`;
    return changed === 1;
  },
  async failed(claim, { code, permanent, invalidDevice, delaySeconds }) {
    return resourceTransaction(async (db) => {
      // Device/account mutation takes the same parent-before-queue lock order.
      if (invalidDevice) {
        await db.$queryRaw`SELECT id FROM users WHERE id=${claim.recipientUserId} FOR SHARE`;
        await db.$queryRaw`SELECT id FROM devices WHERE id=${claim.deviceId} FOR UPDATE`;
      }
      if (!(await validLease(db, claim)).length) return false;
      await db.$executeRaw`UPDATE active_notification_deliveries
        SET status=CASE WHEN ${permanent} OR attempts>=max_attempts THEN 'FAILED'::push_delivery_status ELSE 'PENDING'::push_delivery_status END,
          next_attempt_at=CASE WHEN ${permanent} OR attempts>=max_attempts THEN NULL ELSE clock_timestamp()+make_interval(secs=>${delaySeconds}) END,
          lease_expires_at=NULL,last_error_code=${code}
        WHERE id=${claim.id}`;
      if (invalidDevice) await db.$executeRaw`UPDATE active_devices SET deleted_at=clock_timestamp()
        WHERE id=${claim.deviceId} AND user_id=${claim.recipientUserId} AND fcm_token=${claim.deviceToken}`;
      return true;
    });
  }
};
