import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { resourceTransaction } from '../../utils/resource-transaction.js';

const conversationSelect = Prisma.sql`SELECT c.id,c.customer_id AS "customerId",c.worker_user_id AS "workerUserId",
  c.worker_id AS "workerId",cu.full_name AS "customerName",wu.full_name AS "workerName",
  cu.profile_image_upload_id AS "customerImageUploadId",wu.profile_image_upload_id AS "workerImageUploadId",
  c.last_message_id AS "lastMessageId",c.last_message AS "lastMessage",c.last_message_at AS "lastMessageAt",
  c.created_at AS "createdAt",c.updated_at AS "updatedAt",
  to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
  FROM conversation_summaries c JOIN users cu ON cu.id=c.customer_id JOIN users wu ON wu.id=c.worker_user_id`;
const requestSelect = Prisma.sql`SELECT r.id,r.customer_id AS "customerId",r.worker_user_id AS "workerUserId",r.worker_id AS "workerId",
  cu.full_name AS "customerName",wu.full_name AS "workerName",r.details,r.scheduled_at AS "scheduledAt",r.status,
  r.version,r.status_changed_by AS "statusChangedBy",r.status_reason AS "statusReason",r.status_changed_at AS "statusChangedAt",
  r.created_at AS "createdAt",r.updated_at AS "updatedAt",
  to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
  FROM active_service_requests r JOIN users cu ON cu.id=r.customer_id JOIN users wu ON wu.id=r.worker_user_id`;
const reviewSelect = Prisma.sql`SELECT r.id,r.worker_id AS "workerId",r.user_id AS "userId",r.request_id AS "requestId",
  u.full_name AS "userName",wu.full_name AS "workerName",r.rating,r.comment,r.created_at AS "createdAt",r.updated_at AS "updatedAt",
  to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
  FROM active_reviews r JOIN users u ON u.id=r.user_id JOIN worker_profiles w ON w.id=r.worker_id JOIN users wu ON wu.id=w.user_id`;
const messageSelect = Prisma.sql`SELECT m.id,m.conversation_id AS "conversationId",m.sender_id AS "senderId",
  m.message_number AS "messageNumber",m.text,m.sent_at AS "sentAt" FROM active_messages m`;
const actorLive = (userId) => Prisma.sql`EXISTS(SELECT 1 FROM active_users actor WHERE actor.id=${userId} AND actor.account_status='ACTIVE')`;
const member = (alias, userId) => Prisma.sql`(${alias}.customer_id=${userId} OR ${alias}.worker_user_id=${userId})`;
const before = (column, idColumn, cursor) => cursor
  ? Prisma.sql`AND (${column},${idColumn})<(${cursor.at}::timestamptz,${cursor.id}::bigint)` : Prisma.empty;

async function lockAccounts(db, userIds, actorId) {
  const rows = await db.$queryRaw`SELECT id,account_status AS status,deleted_at AS "deletedAt" FROM users
    WHERE id=ANY(${userIds.map((id) => BigInt(id))}::bigint[]) ORDER BY id FOR UPDATE`;
  const actor = rows.find((row) => idNumber(row.id) === actorId);
  if (!actor || actor.deletedAt || actor.status !== 'ACTIVE') throw new AppError('NOT_AUTHENTICATED', 401);
  return rows;
}
const activeAccount = (rows, id) => rows.some((r) => idNumber(r.id) === idNumber(id) && !r.deletedAt && r.status === 'ACTIVE');
async function lockParticipant(db, tableName, id, userId, includeDeleted = false) {
  // Table names are internal constants. Resource participants are immutable.
  const table = tableName === 'conversations' ? Prisma.sql`conversations` : Prisma.sql`service_requests`;
  const discover = (await db.$queryRaw(Prisma.sql`SELECT customer_id AS "customerId",worker_user_id AS "workerUserId"
    FROM ${table} WHERE id=${id}`))[0];
  if (!discover || ![discover.customerId, discover.workerUserId].map(idNumber).includes(userId)) throw new AppError('NOT_FOUND', 404);
  const accounts = await lockAccounts(db, [discover.customerId, discover.workerUserId], userId);
  const row = (await db.$queryRaw(Prisma.sql`SELECT id,customer_id AS "customerId",worker_user_id AS "workerUserId",
    worker_id AS "workerId",deleted_at AS "deletedAt" ${tableName === 'service_requests' ? Prisma.sql`,status,version` : Prisma.empty}
    FROM ${table} WHERE id=${id} FOR UPDATE`))[0];
  if (!row || (!includeDeleted && row.deletedAt)) throw new AppError('NOT_FOUND', 404);
  return { ...row, accounts };
}
async function workerContext(db, workerId, userId) {
  const row = (await db.$queryRaw`SELECT user_id AS "userId" FROM worker_profiles WHERE id=${workerId}`)[0];
  if (!row) throw new AppError('NOT_FOUND', 404);
  const accounts = await lockAccounts(db, [userId, row.userId], userId);
  const worker = (await db.$queryRaw`SELECT id,user_id AS "userId",deleted_at AS "deletedAt"
    FROM worker_profiles WHERE id=${workerId} FOR UPDATE`)[0];
  return { ...worker, accounts };
}
async function notification(db, recipientId, type, title, body, target) {
  // Inactive peers retain their history but receive no new inbox/delivery rows.
  return (await db.$queryRaw`INSERT INTO notifications(recipient_user_id,type,title,body,conversation_id,request_id,worker_id)
    SELECT ${recipientId},${type}::notification_type,${title},${body},${target.conversationId ?? null}::bigint,
      ${target.requestId ?? null}::bigint,${target.workerId ?? null}::bigint
    FROM active_users WHERE id=${recipientId} AND account_status='ACTIVE'
    RETURNING id,recipient_user_id AS "recipientUserId",type,title,body,conversation_id AS "conversationId",
      request_id AS "requestId",worker_id AS "workerId",created_at AS "createdAt"`)[0] ?? null;
}
async function publicWorker(db, workerId) {
  const row = (await db.$queryRaw`SELECT id FROM public_worker_profiles WHERE id=${workerId}`)[0];
  if (!row) throw new AppError('NOT_FOUND', 404);
}
const conversationById = async (id, userId, db = prisma) => (await db.$queryRaw(Prisma.sql`${conversationSelect}
  WHERE c.id=${id} AND ${member(Prisma.sql`c`, userId)} AND ${actorLive(userId)}`))[0] ?? null;
const requestById = async (id, userId, db = prisma) => (await db.$queryRaw(Prisma.sql`${requestSelect}
  WHERE r.id=${id} AND ${member(Prisma.sql`r`, userId)} AND ${actorLive(userId)}`))[0] ?? null;

export const interactionRepository = {
  conversation: conversationById,
  request: requestById,
  conversations: (userId, query, cursor) => prisma.$queryRaw(Prisma.sql`${conversationSelect}
    WHERE ${member(Prisma.sql`c`, userId)} AND ${actorLive(userId)} ${before(Prisma.sql`c.updated_at`, Prisma.sql`c.id`, cursor)}
    ORDER BY c.updated_at DESC,c.id DESC LIMIT ${query.limit + 1}`),
  async startConversation(userId, workerId) {
    return resourceTransaction(async (db) => {
      const worker = await workerContext(db, workerId, userId);
      if (idNumber(worker.userId) === userId) throw new AppError('FORBIDDEN', 403);
      const prior = (await db.$queryRaw`SELECT id,deleted_at AS "deletedAt" FROM conversations
        WHERE customer_id=${userId} AND worker_id=${workerId} FOR UPDATE`)[0];
      if (prior?.deletedAt) throw new AppError('CONVERSATION_DELETED', 409);
      if (prior) return { created: false, conversation: await conversationById(prior.id, userId, db) };
      await publicWorker(db, workerId);
      const row = (await db.$queryRaw`INSERT INTO conversations(customer_id,worker_id) VALUES(${userId},${workerId}) RETURNING id`)[0];
      return { created: true, conversation: await conversationById(row.id, userId, db) };
    });
  },
  async messages(id, userId, query) {
    if (!await conversationById(id, userId)) throw new AppError('NOT_FOUND', 404);
    return prisma.$queryRaw(Prisma.sql`${messageSelect} JOIN active_conversations c ON c.id=m.conversation_id
      WHERE c.id=${id} AND ${member(Prisma.sql`c`, userId)} AND ${actorLive(userId)}
      ${query.beforeNumber === undefined ? Prisma.empty : Prisma.sql`AND m.message_number<${query.beforeNumber}`}
      ORDER BY m.message_number DESC LIMIT ${query.limit + 1}`);
  },
  async sendMessage(id, userId, text) {
    return resourceTransaction(async (db) => {
      const context = await lockParticipant(db, 'conversations', id, userId);
      if (![context.customerId, context.workerUserId].every((id) => activeAccount(context.accounts, id)))
        throw new AppError('PARTICIPANT_UNAVAILABLE', 409);
      const message = (await db.$queryRaw`INSERT INTO messages(conversation_id,sender_id,text) VALUES(${id},${userId},${text})
        RETURNING id,conversation_id AS "conversationId",sender_id AS "senderId",message_number AS "messageNumber",text,sent_at AS "sentAt"`)[0];
      const recipientId = idNumber(context.customerId) === userId ? context.workerUserId : context.customerId;
      const inbox = await notification(db, recipientId, 'NEW_MESSAGE', 'New message', 'You received a new message.', { conversationId: id });
      return { message, notification: inbox, conversation: await conversationById(id, userId, db) };
    });
  },
  async setMessageDeleted(conversationId, messageId, userId, deleted) {
    return resourceTransaction(async (db) => {
      await lockParticipant(db, 'conversations', conversationId, userId);
      const message = (await db.$queryRaw`SELECT id,sender_id AS "senderId",deleted_at AS "deletedAt" FROM messages
        WHERE id=${messageId} AND conversation_id=${conversationId} FOR UPDATE`)[0];
      if (!message || idNumber(message.senderId) !== userId) throw new AppError('NOT_FOUND', 404);
      if (Boolean(message.deletedAt) !== deleted) await db.$executeRaw`UPDATE messages
        SET deleted_at=${deleted ? new Date() : null}::timestamptz WHERE id=${messageId}`;
      return { conversation: await conversationById(conversationId, userId, db) };
    });
  },
  async setConversationDeleted(id, userId, deleted) {
    return resourceTransaction(async (db) => {
      const row = await lockParticipant(db, 'conversations', id, userId, true);
      if (idNumber(row.customerId) !== userId) throw new AppError('FORBIDDEN', 403);
      if (!deleted) {
        const profile = (await db.$queryRaw`SELECT id FROM active_worker_profiles WHERE id=${row.workerId} FOR SHARE`)[0];
        if (!profile || !activeAccount(row.accounts, row.workerUserId)) throw new AppError('PARTICIPANT_UNAVAILABLE', 409);
      }
      if (Boolean(row.deletedAt) !== deleted) {
        await db.$executeRaw`UPDATE conversations SET deleted_at=${deleted ? new Date() : null}::timestamptz WHERE id=${id}`;
        if (!deleted) {
          await db.$executeRaw`UPDATE active_conversations SET updated_at=updated_at WHERE id=${id}`;
          await db.$executeRaw`UPDATE contact_history SET deleted_at=NULL WHERE conversation_id=${id} AND deleted_at IS NOT NULL`;
        }
      }
      return { participants: [row.customerId, row.workerUserId], conversation: deleted ? null : await conversationById(id, userId, db) };
    });
  },
  async createRequest(userId, input) {
    return resourceTransaction(async (db) => {
      const worker = await workerContext(db, input.workerId, userId);
      if (idNumber(worker.userId) === userId) throw new AppError('FORBIDDEN', 403);
      await publicWorker(db, input.workerId);
      const row = (await db.$queryRaw`INSERT INTO service_requests(customer_id,worker_id,details,scheduled_at)
        VALUES(${userId},${input.workerId},${input.details ?? null},${input.scheduledAt == null ? null : new Date(input.scheduledAt)}) RETURNING id`)[0];
      const notifications = [await notification(db, worker.userId, 'SERVICE_REQUEST_RECEIVED', 'New service request',
        'You received a new service request.', { requestId: row.id }),
      await notification(db, userId, 'SERVICE_REQUEST_SENT', 'Request sent', 'Your service request was sent.', { requestId: row.id })];
      return { request: await requestById(row.id, userId, db), notifications };
    });
  },
  requests: (userId, query, cursor) => prisma.$queryRaw(Prisma.sql`${requestSelect}
    WHERE ${query.as === 'worker' ? Prisma.sql`r.worker_user_id=${userId}` : Prisma.sql`r.customer_id=${userId}`}
    AND ${actorLive(userId)} ${query.status ? Prisma.sql`AND r.status=${query.status}::service_request_status` : Prisma.empty}
    ${before(Prisma.sql`r.created_at`, Prisma.sql`r.id`, cursor)} ORDER BY r.created_at DESC,r.id DESC LIMIT ${query.limit + 1}`),
  async updateRequest(id, userId, input) {
    return resourceTransaction(async (db) => {
      const row = await lockParticipant(db, 'service_requests', id, userId);
      if (idNumber(row.version) !== input.version) throw new AppError('STALE_REQUEST', 409);
      const isWorker = idNumber(row.workerUserId) === userId;
      const allowed = isWorker ? (row.status === 'PENDING' && ['ACCEPTED', 'DECLINED'].includes(input.status)) ||
        (row.status === 'ACCEPTED' && input.status === 'COMPLETED') : ['PENDING', 'ACCEPTED'].includes(row.status) && input.status === 'CANCELLED';
      if (!allowed) throw new AppError('INVALID_TRANSITION', 409);
      await db.$executeRaw`UPDATE active_service_requests SET status=${input.status}::service_request_status,
        status_changed_by=${userId},status_reason=${input.reason ?? null} WHERE id=${id}`;
      const recipientId = isWorker ? row.customerId : row.workerUserId;
      const inbox = await notification(db, recipientId, 'SERVICE_REQUEST_UPDATED', 'Request updated',
        `The service request was ${input.status.toLowerCase()}.`, { requestId: id });
      return { request: await requestById(id, userId, db), notifications: [inbox] };
    });
  },
  async events(id, userId, query) {
    if (!await requestById(id, userId)) throw new AppError('NOT_FOUND', 404);
    return prisma.$queryRaw`SELECT e.id,e.request_id AS "requestId",e.version,e.from_status AS "fromStatus",e.to_status AS "toStatus",
      e.actor_id AS "actorId",e.reason,e.occurred_at AS "occurredAt" FROM active_service_request_events e
      JOIN active_service_requests r ON r.id=e.request_id WHERE r.id=${id} AND (r.customer_id=${userId} OR r.worker_user_id=${userId})
      AND EXISTS(SELECT 1 FROM active_users actor WHERE actor.id=${userId} AND actor.account_status='ACTIVE')
      AND e.version>${query.afterVersion ?? 0} ORDER BY e.version LIMIT ${query.limit + 1}`;
  },
  async setRequestDeleted(id, userId, deleted) {
    return resourceTransaction(async (db) => {
      const row = await lockParticipant(db, 'service_requests', id, userId, true);
      if (idNumber(row.customerId) !== userId) throw new AppError('FORBIDDEN', 403);
      if (!['COMPLETED', 'DECLINED', 'CANCELLED'].includes(row.status)) throw new AppError('REQUEST_NOT_TERMINAL', 409);
      if (!deleted) {
        const profile = (await db.$queryRaw`SELECT id FROM active_worker_profiles WHERE id=${row.workerId} FOR SHARE`)[0];
        if (!profile || !activeAccount(row.accounts, row.workerUserId)) throw new AppError('PARTICIPANT_UNAVAILABLE', 409);
      }
      if (Boolean(row.deletedAt) !== deleted) {
        await db.$executeRaw`UPDATE service_requests SET deleted_at=${deleted ? new Date() : null}::timestamptz WHERE id=${id}`;
        if (!deleted) {
          await db.$executeRaw`UPDATE service_request_events SET deleted_at=NULL WHERE request_id=${id} AND deleted_at IS NOT NULL`;
          await db.$executeRaw`UPDATE contact_history SET deleted_at=NULL WHERE request_id=${id} AND deleted_at IS NOT NULL`;
        }
      }
      return { participants: [row.customerId, row.workerUserId], request: deleted ? null : await requestById(id, userId, db) };
    });
  },
  async reviewList(workerId, userId, query, cursor) {
    const visible = await prisma.$queryRaw`SELECT id FROM public_worker_profiles WHERE id=${workerId}
      UNION SELECT id FROM active_worker_profiles WHERE id=${workerId} AND user_id=${userId}`;
    if (!visible.length) throw new AppError('NOT_FOUND', 404);
    return prisma.$queryRaw(Prisma.sql`${reviewSelect} WHERE r.worker_id=${workerId} AND ${actorLive(userId)}
      AND (EXISTS(SELECT 1 FROM public_worker_profiles p WHERE p.id=${workerId}) OR
        EXISTS(SELECT 1 FROM active_worker_profiles own WHERE own.id=${workerId} AND own.user_id=${userId}))
      ${before(Prisma.sql`r.created_at`, Prisma.sql`r.id`, cursor)} ORDER BY r.created_at DESC,r.id DESC LIMIT ${query.limit + 1}`);
  },
  myReviews: (userId, query, cursor) => prisma.$queryRaw(Prisma.sql`${reviewSelect} WHERE r.user_id=${userId} AND ${actorLive(userId)}
    ${before(Prisma.sql`r.created_at`, Prisma.sql`r.id`, cursor)} ORDER BY r.created_at DESC,r.id DESC LIMIT ${query.limit + 1}`),
  async saveReview(workerId, userId, input, reviewId) {
    return resourceTransaction(async (db) => {
      const worker = await workerContext(db, workerId, userId);
      if (worker.deletedAt) throw new AppError('WORKER_UNAVAILABLE', 409);
      if (idNumber(worker.userId) === userId) throw new AppError('FORBIDDEN', 403);
      const prior = (await db.$queryRaw`SELECT id,request_id AS "requestId" FROM active_reviews
        WHERE worker_id=${workerId} AND user_id=${userId} FOR UPDATE`)[0];
      if (reviewId !== undefined && (!prior || idNumber(prior.id) !== reviewId)) throw new AppError('NOT_FOUND', 404);
      const requestId = input.requestId ?? prior?.requestId;
      if (prior && idNumber(prior.requestId) !== idNumber(requestId)) throw new AppError('REVIEW_REQUEST_IMMUTABLE', 409);
      const proof = await db.$queryRaw`SELECT id FROM active_service_requests WHERE id=${requestId}
        AND worker_id=${workerId} AND customer_id=${userId} AND status='COMPLETED' FOR SHARE`;
      if (!proof.length) throw new AppError('COMPLETED_REQUEST_REQUIRED', 409);
      let id = prior?.id;
      if (prior) await db.$executeRaw`UPDATE active_reviews SET rating=${input.rating}::smallint,comment=${input.comment ?? null} WHERE id=${id}`;
      else id = (await db.$queryRaw`INSERT INTO reviews(worker_id,user_id,request_id,rating,comment)
        VALUES(${workerId},${userId},${requestId},${input.rating}::smallint,${input.comment ?? null}) RETURNING id`)[0].id;
      const inbox = prior ? null : await notification(db, worker.userId, 'NEW_REVIEW', 'New review', 'You received a new review.', { workerId });
      const review = (await db.$queryRaw(Prisma.sql`${reviewSelect} WHERE r.id=${id}`))[0];
      return { created: !prior, review, notification: inbox, workerUserId: worker.userId };
    });
  },
  async ownedReview(reviewId, userId) {
    return (await prisma.$queryRaw`SELECT id,worker_id AS "workerId" FROM active_reviews WHERE id=${reviewId} AND user_id=${userId}`)[0] ?? null;
  },
  async setReviewDeleted(id, userId, deleted) {
    return resourceTransaction(async (db) => {
      const discover = (await db.$queryRaw`SELECT worker_id AS "workerId" FROM reviews WHERE id=${id} AND user_id=${userId}`)[0];
      if (!discover) throw new AppError('NOT_FOUND', 404);
      const worker = await workerContext(db, discover.workerId, userId);
      const row = (await db.$queryRaw`SELECT id,deleted_at AS "deletedAt" FROM reviews WHERE id=${id} FOR UPDATE`)[0];
      if (!deleted && worker.deletedAt) throw new AppError('WORKER_UNAVAILABLE', 409);
      if (Boolean(row.deletedAt) !== deleted) await db.$executeRaw`UPDATE reviews SET deleted_at=${deleted ? new Date() : null}::timestamptz WHERE id=${id}`;
      const review = deleted ? null : (await db.$queryRaw(Prisma.sql`${reviewSelect} WHERE r.id=${id}`))[0];
      return { review, workerId: discover.workerId, workerUserId: worker.userId };
    });
  }
};
