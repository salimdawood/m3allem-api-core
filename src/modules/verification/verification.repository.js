import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { resourceTransaction } from '../../utils/resource-transaction.js';

const projection = Prisma.sql`SELECT d.id,d.worker_id AS "workerId",d.upload_id AS "uploadId",d.type,d.status,
  d.submission_number AS "submissionNumber",d.submitted_at AS "submittedAt",d.reviewed_at AS "reviewedAt",
  d.reviewed_by AS "reviewedBy",d.rejection_reason AS "rejectionReason",(w.current_identity_document_id=d.id) AS "isCurrent",
  (SELECT full_name FROM active_users WHERE id=w.user_id) AS "workerName"
  FROM active_identity_documents d JOIN active_worker_profiles w ON w.id=d.worker_id`;
async function lockAccounts(db, userIds, actorId = userIds[0]) {
  const rows = await db.$queryRaw`SELECT id,is_admin AS "isAdmin" FROM active_users
    WHERE id=ANY(${userIds.map((id) => BigInt(id))}::bigint[]) AND account_status='ACTIVE' ORDER BY id FOR UPDATE`;
  if (!rows.some((r) => idNumber(r.id) === idNumber(actorId))) throw new AppError('NOT_AUTHENTICATED', 401);
  if (rows.length !== new Set(userIds.map(idNumber)).size) throw new AppError('ACCOUNT_UNAVAILABLE', 409);
  return rows;
}
async function workerForOwner(db, userId) {
  await lockAccounts(db, [userId]);
  const worker = (await db.$queryRaw`SELECT id FROM active_worker_profiles WHERE user_id=${userId} FOR UPDATE`)[0];
  if (!worker) throw new AppError('NOT_FOUND', 404);
  return worker;
}
async function adminLock(db, adminId) {
  const row = (await lockAccounts(db, [adminId]))[0];
  if (!row.isAdmin) throw new AppError('FORBIDDEN', 403);
}
async function reviewContext(db, documentId, adminId) {
  // Discover immutable participants, then lock account IDs in a consistent order.
  const owner = (await db.$queryRaw`SELECT w.user_id AS "userId",w.id AS "workerId" FROM active_identity_documents d
    JOIN active_worker_profiles w ON w.id=d.worker_id WHERE d.id=${documentId}`)[0];
  if (!owner) throw new AppError('NOT_FOUND', 404);
  if (idNumber(owner.userId) === adminId) throw new AppError('FORBIDDEN', 403);
  const accounts = await lockAccounts(db, [adminId, owner.userId]);
  if (!accounts.find((a) => idNumber(a.id) === adminId)?.isAdmin) throw new AppError('FORBIDDEN', 403);
  const worker = (await db.$queryRaw`SELECT id,current_identity_document_id AS "documentId"
    FROM active_worker_profiles WHERE id=${owner.workerId} FOR UPDATE`)[0];
  if (!worker) throw new AppError('NOT_FOUND', 404);
  const doc = (await db.$queryRaw`SELECT id,status,upload_id AS "uploadId" FROM active_identity_documents
    WHERE id=${documentId} FOR UPDATE`)[0];
  if (!doc || worker.documentId !== doc.id || doc.status !== 'PENDING') throw new AppError('VERIFICATION_NOT_REVIEWABLE', 409);
  return { ...owner, uploadId: doc.uploadId };
}
export const verificationRepository = {
  async submit(userId, input) {
    return resourceTransaction(async (db) => {
      const worker = await workerForOwner(db, userId);
      const upload = await db.$queryRaw`SELECT id FROM active_file_uploads
        WHERE id=${input.uploadId} AND owner_user_id=${userId} AND purpose='IDENTITY_DOCUMENT' AND status='READY' FOR UPDATE`;
      if (!upload.length) throw new AppError('INVALID_UPLOAD', 400);
      const prior = await db.$queryRaw`SELECT id FROM identity_documents WHERE upload_id=${input.uploadId}`;
      if (prior.length) throw new AppError('UPLOAD_ALREADY_SUBMITTED', 409);
      const created = (await db.$queryRaw`INSERT INTO identity_documents(worker_id,type,upload_id)
        VALUES(${worker.id},${input.type}::identity_document_type,${input.uploadId}) RETURNING id`)[0];
      return (await db.$queryRaw(Prisma.sql`${projection} WHERE d.id=${created.id}`))[0];
    });
  },
  async current(userId) {
    return (await prisma.$queryRaw(Prisma.sql`${projection} JOIN active_users u ON u.id=w.user_id AND u.account_status='ACTIVE'
      WHERE w.user_id=${userId} AND d.id=w.current_identity_document_id`))[0] ?? null;
  },
  history: (userId, query) => prisma.$queryRaw(Prisma.sql`${projection} JOIN active_users u ON u.id=w.user_id AND u.account_status='ACTIVE'
    WHERE w.user_id=${userId} AND d.id>${query.afterId ?? 0} ORDER BY d.id LIMIT ${query.limit + 1}`),
  async pending(adminId, query) {
    return resourceTransaction(async (db) => {
      await adminLock(db, adminId);
      return db.$queryRaw(Prisma.sql`${projection} JOIN active_users u ON u.id=w.user_id AND u.account_status='ACTIVE'
        JOIN active_file_uploads f ON f.id=d.upload_id AND f.status='READY'
        WHERE d.status='PENDING' AND d.id=w.current_identity_document_id AND w.user_id<>${adminId}
          AND d.id>${query.afterId ?? 0} ORDER BY d.id LIMIT ${query.limit + 1}`);
    });
  },
  async documentForReview(documentId, adminId) {
    return resourceTransaction(async (db) => {
      const doc = await reviewContext(db, documentId, adminId);
      const file = (await db.$queryRaw`SELECT bucket_name AS "bucketName",object_key AS "objectKey"
        FROM active_file_uploads WHERE id=${doc.uploadId} AND status='READY' AND purpose='IDENTITY_DOCUMENT' FOR SHARE`)[0];
      if (!file) throw new AppError('UPLOAD_UNAVAILABLE', 409);
      return file;
    });
  },
  async review(documentId, adminId, approved, reason) {
    return resourceTransaction(async (db) => {
      const context = await reviewContext(db, documentId, adminId);
      await db.$executeRaw`UPDATE active_identity_documents SET status=${approved ? 'VERIFIED' : 'REJECTED'}::document_review_status,
        reviewed_by=${adminId},rejection_reason=${approved ? null : reason} WHERE id=${documentId}`;
      const notification = (await db.$queryRaw`INSERT INTO notifications(recipient_user_id,type,title,body,worker_id)
        VALUES(${context.userId},'VERIFICATION_UPDATE','Verification update',
          ${approved ? 'Your identity was verified.' : 'Your identity document was rejected.'},${context.workerId})
        RETURNING id,type,title,body,worker_id AS "workerId",created_at AS "createdAt"`)[0];
      return { ...context, notification };
    });
  },
  async softDelete(documentId, userId) {
    return resourceTransaction(async (db) => {
      const worker = await workerForOwner(db, userId);
      const doc = (await db.$queryRaw`SELECT id,deleted_at AS "deletedAt" FROM identity_documents
        WHERE id=${documentId} AND worker_id=${worker.id} FOR UPDATE`)[0];
      if (!doc) throw new AppError('NOT_FOUND', 404);
      if (!doc.deletedAt) await db.$executeRaw`UPDATE identity_documents SET deleted_at=clock_timestamp() WHERE id=${documentId}`;
      const status = (await db.$queryRaw`SELECT verification_status AS "verificationStatus" FROM worker_verification WHERE worker_id=${worker.id}`)[0];
      return { workerId: worker.id, ...status };
    });
  }
};
