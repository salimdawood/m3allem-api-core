import { prisma } from '../../config/database.js';

export const accountRepository = {
  avatarOwned: (userId, id) => prisma.fileUpload.findFirst({ where: {
    id, ownerUserId: userId, purpose: 'PROFILE_IMAGE', status: 'READY', deletedAt: null
  }, select: { id: true } }),
  publicUser: (id) => prisma.user.findFirst({ where: { id, deletedAt: null, accountStatus: 'ACTIVE' },
    select: { id: true, fullName: true, profileImageUploadId: true } }),
  settings: (userId) => prisma.$queryRaw`SELECT notifications_enabled AS "notificationsEnabled",
    reminder_lead_minutes AS "reminderLeadMinutes",language FROM active_user_settings WHERE user_id=${userId}`,
  async upsertSettings(userId, input) {
    return prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM active_users WHERE id=${userId} FOR UPDATE`;
      const old = await db.userSettings.findUnique({ where: { userId } });
      if (old?.deletedAt) await db.userSettings.update({ where: { userId }, data: { deletedAt: null } });
      return db.userSettings.upsert({ where: { userId }, create: { userId, ...input }, update: input });
    });
  },
  favorites: (userId) => prisma.$queryRaw`SELECT worker_id AS id FROM active_favorites
    WHERE user_id=${userId} ORDER BY created_at DESC,worker_id DESC`,
  async addFavorite(userId, workerId) {
    return prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM active_users WHERE id=${userId} FOR UPDATE`;
      const visible = await db.$queryRaw`SELECT id FROM public_worker_profiles WHERE id=${workerId} AND user_id<>${userId}`;
      if (!visible.length) return false;
      await db.$executeRaw`INSERT INTO favorites(user_id,worker_id) VALUES(${userId},${workerId})
        ON CONFLICT(user_id,worker_id) DO UPDATE SET deleted_at=NULL WHERE favorites.deleted_at IS NOT NULL`;
      return true;
    });
  },
  removeFavorite: (userId, workerId) => prisma.$executeRaw`UPDATE active_favorites SET deleted_at=clock_timestamp()
    WHERE user_id=${userId} AND worker_id=${workerId}`,
  notifications: (userId) => prisma.$queryRaw`SELECT id,type,title,body,request_id AS "requestId",
    conversation_id AS "conversationId",worker_id AS "workerId",read_at AS "readAt",created_at AS "createdAt"
    FROM active_notifications WHERE recipient_user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 200`,
  readNotification: (userId, id) => prisma.$executeRaw`UPDATE active_notifications SET read_at=clock_timestamp()
    WHERE recipient_user_id=${userId} AND id=${id} AND read_at IS NULL`,
  readAllNotifications: (userId) => prisma.$executeRaw`UPDATE active_notifications SET read_at=clock_timestamp()
    WHERE recipient_user_id=${userId} AND read_at IS NULL`,
  upsertDevice: (userId, input) => prisma.$executeRaw`INSERT INTO devices(fcm_token,user_id,platform,locale,app_version,last_seen_at)
    VALUES(${input.fcmToken},${userId},${input.platform},${input.locale ?? null},${input.appVersion ?? null},clock_timestamp())
    ON CONFLICT(fcm_token) WHERE deleted_at IS NULL DO UPDATE SET user_id=EXCLUDED.user_id,
      platform=EXCLUDED.platform,locale=EXCLUDED.locale,app_version=EXCLUDED.app_version,last_seen_at=clock_timestamp()`,
  removeDevice: (userId, token) => prisma.$executeRaw`UPDATE active_devices SET deleted_at=clock_timestamp()
    WHERE user_id=${userId} AND fcm_token=${token}`,
  contactHistory: (userId) => prisma.$queryRaw`SELECT h.id,h.worker_id AS "workerId",u.full_name AS "workerName",
    u.profile_image_upload_id AS "profileImageUploadId",h.interaction_type AS "interactionType",
    h.created_at AS "createdAt",h.conversation_id AS "conversationId",h.request_id AS "requestId",sr.status AS "requestStatus"
    FROM active_contact_history h JOIN worker_profiles w ON w.id=h.worker_id JOIN users u ON u.id=w.user_id
    LEFT JOIN service_requests sr ON sr.id=h.request_id WHERE h.customer_id=${userId}
    ORDER BY h.created_at DESC,h.id DESC LIMIT 250`,
  addContactHistory: (userId, workerId, type) => prisma.$executeRaw`INSERT INTO contact_history(customer_id,worker_id,interaction_type)
    SELECT ${userId},w.id,${type}::interaction_type FROM public_worker_profiles w WHERE w.id=${workerId} AND w.user_id<>${userId}`,
  softDelete: (userId) => prisma.$executeRaw`UPDATE active_users SET deleted_at=clock_timestamp() WHERE id=${userId}`,
  async setAccountStatus(actorId, userId, input) {
    return prisma.$transaction(async (db) => {
      // Recheck admin authority under a lock in the same transaction as the edit.
      const actor = await db.$queryRaw`SELECT id FROM active_users
        WHERE id=${actorId} AND account_status='ACTIVE' AND is_admin FOR SHARE`;
      if (!actor.length) return false;
      const changed = await db.$executeRaw`UPDATE active_users
        SET account_status=${input.status}::account_status,suspension_reason=${input.reason ?? null}
        WHERE id=${userId}`;
      return Boolean(changed);
    });
  }
};
