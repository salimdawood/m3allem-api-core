import { prisma } from '../config/database.js';
import { resourceTransaction } from '../utils/resource-transaction.js';

export const reminderRepository = {
  candidates: (limit = 100) => prisma.$queryRaw`SELECT id,request_id AS "requestId",recipient_user_id AS "recipientUserId"
    FROM active_scheduled_reminders WHERE notification_id IS NULL AND cancelled_at IS NULL
      AND trigger_at<=clock_timestamp() ORDER BY trigger_at,id LIMIT ${limit}`,
  async materialize(candidate) {
    return resourceTransaction(async (db) => {
      // Lock parents first, matching settings/request/account updates. Candidate
      // discovery is unlocked; eligibility is checked again under these locks.
      const user = (await db.$queryRaw`SELECT id,account_status AS status,deleted_at AS "deletedAt" FROM users
        WHERE id=${candidate.recipientUserId} FOR SHARE`)[0];
      const request = (await db.$queryRaw`SELECT id,status,scheduled_at AS "scheduledAt",deleted_at AS "deletedAt",
        (scheduled_at>clock_timestamp()) AS future
        FROM service_requests WHERE id=${candidate.requestId} FOR SHARE`)[0];
      const settings = (await db.$queryRaw`SELECT notifications_enabled AS enabled,reminder_lead_minutes AS lead
        FROM active_user_settings WHERE user_id=${candidate.recipientUserId} FOR SHARE`)[0];
      const reminder = (await db.$queryRaw`SELECT id,notification_id AS "notificationId",cancelled_at AS "cancelledAt",
        (trigger_at<=clock_timestamp()) AS due FROM active_scheduled_reminders
        WHERE id=${candidate.id} FOR UPDATE SKIP LOCKED`)[0];
      if (!reminder || reminder.notificationId || reminder.cancelledAt || !reminder.due) return null;
      if (!user || user.deletedAt || user.status !== 'ACTIVE' || !request || request.deletedAt ||
        request.status !== 'ACCEPTED' || !request.future || settings?.enabled === false || settings?.lead === 0) {
        await db.$executeRaw`UPDATE active_scheduled_reminders SET cancelled_at=clock_timestamp() WHERE id=${candidate.id}`;
        return null;
      }
      // SQL links reminder.notification_id and enqueues eligible device deliveries.
      return (await db.$queryRaw`INSERT INTO notifications(recipient_user_id,type,title,body,request_id,reminder_id)
        VALUES(${candidate.recipientUserId},'APPOINTMENT_REMINDER','Appointment reminder',
          'You have an upcoming appointment.',${candidate.requestId},${candidate.id})
        RETURNING id,recipient_user_id AS "recipientUserId",type,title,body,request_id AS "requestId",
          reminder_id AS "reminderId",created_at AS "createdAt"`)[0];
    });
  }
};
