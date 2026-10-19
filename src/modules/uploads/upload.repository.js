import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { resourceTransaction } from '../../utils/resource-transaction.js';

const select = `SELECT f.id,f.owner_user_id AS "ownerUserId",f.purpose,f.status,f.bucket_name AS "bucketName",
  f.object_key AS "objectKey",f.content_type AS "contentType",f.size_bytes AS "sizeBytes",f.created_at AS "createdAt",
  f.uploaded_at AS "uploadedAt",f.deleted_at AS "deletedAt",f.failure_code AS "failureCode" FROM file_uploads f`;
async function accountLock(db, userId) {
  const rows = await db.$queryRaw`SELECT id FROM active_users WHERE id=${userId} AND account_status='ACTIVE' FOR UPDATE`;
  if (!rows.length) throw new AppError('NOT_AUTHENTICATED', 401);
}
async function owned(db, id, userId) {
  await accountLock(db, userId);
  const row = (await db.$queryRawUnsafe(`${select} WHERE f.id=$1 AND f.owner_user_id=$2 FOR UPDATE`, id, userId))[0];
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}
export const uploadRepository = {
  async reserve(userId, purpose, location) {
    return resourceTransaction(async (db) => {
      await accountLock(db, userId);
      const row = (await db.$queryRaw`INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
        VALUES(${userId},${purpose}::upload_purpose,${location.bucketName},${location.objectKey}) RETURNING id`)[0];
      return (await db.$queryRawUnsafe(`${select} WHERE f.id=$1`, row.id))[0];
    });
  },
  async ready(id, userId, contentType, sizeBytes, sha256) {
    return resourceTransaction(async (db) => {
      const row = await owned(db, id, userId);
      if (row.deletedAt || row.status !== 'PENDING') throw new AppError('UPLOAD_UNAVAILABLE', 409);
      await db.$executeRaw`UPDATE active_file_uploads SET status='READY',content_type=${contentType},
        size_bytes=${sizeBytes},sha256=${sha256} WHERE id=${id}`;
      return (await db.$queryRawUnsafe(`${select} WHERE f.id=$1`, id))[0];
    });
  },
  fail: (id, userId, code) => prisma.$executeRaw`UPDATE file_uploads SET status='FAILED',failure_code=${code}
    WHERE id=${id} AND owner_user_id=${userId} AND status='PENDING'`,
  async accessible(id, userId) {
    // Private files are owner-only here. Admin access goes through the current
    // pending submission endpoint, with fresh authorization in its transaction.
    return (await prisma.$queryRawUnsafe(`${select} WHERE f.id=$1 AND f.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM active_users actor WHERE actor.id=$2 AND actor.account_status='ACTIVE') AND
      (f.owner_user_id=$2 OR (f.purpose='PROFILE_IMAGE' AND f.status='READY' AND EXISTS
        (SELECT 1 FROM active_users u WHERE u.profile_image_upload_id=f.id AND u.account_status='ACTIVE')))`, id, userId))[0] ?? null;
  },
  list: (userId, query) => prisma.$queryRawUnsafe(`${select} WHERE f.owner_user_id=$1 AND f.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM active_users u WHERE u.id=$1 AND u.account_status='ACTIVE')
    AND f.id>$2 ORDER BY f.id LIMIT $3`, userId, query.afterId ?? 0, query.limit + 1),
  async softDelete(id, userId) {
    return resourceTransaction(async (db) => {
      const row = await owned(db, id, userId);
      if (row.deletedAt) return;
      const attached = await db.$queryRaw`SELECT 1 WHERE EXISTS(SELECT 1 FROM active_users WHERE profile_image_upload_id=${id})
        OR EXISTS(SELECT 1 FROM active_identity_documents WHERE upload_id=${id})`;
      if (attached.length) throw new AppError('UPLOAD_IN_USE', 409);
      await db.$executeRaw`UPDATE active_file_uploads SET deleted_at=clock_timestamp() WHERE id=${id}`;
    });
  },
  async restore(id, userId) {
    return resourceTransaction(async (db) => {
      const row = await owned(db, id, userId);
      if (row.status !== 'READY') throw new AppError('UPLOAD_UNAVAILABLE', 409);
      if (row.deletedAt) await db.$executeRaw`UPDATE file_uploads SET deleted_at=NULL WHERE id=${id}`;
      return (await db.$queryRawUnsafe(`${select} WHERE f.id=$1`, id))[0];
    });
  }
};
