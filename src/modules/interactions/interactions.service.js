import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { decodePageCursor, pageResult } from '../../utils/page-cursor.js';
import { interactionRepository as repo } from './interactions.repository.js';
import { realtimeHub } from '../realtime/hub.js';

const milliseconds = (date) => date?.getTime() ?? null;
const optionalId = (id) => id == null ? null : idNumber(id);
const conversationDto = (row) => ({ id: idNumber(row.id), customerId: idNumber(row.customerId), workerId: idNumber(row.workerId),
  workerUserId: idNumber(row.workerUserId), customerName: row.customerName, workerName: row.workerName,
  customerImageUploadId: optionalId(row.customerImageUploadId), workerImageUploadId: optionalId(row.workerImageUploadId),
  lastMessageId: optionalId(row.lastMessageId), lastMessage: row.lastMessage, lastMessageAt: milliseconds(row.lastMessageAt),
  createdAt: milliseconds(row.createdAt), updatedAt: milliseconds(row.updatedAt) });
const messageDto = (row) => ({ id: idNumber(row.id), conversationId: idNumber(row.conversationId), senderId: idNumber(row.senderId),
  messageNumber: idNumber(row.messageNumber), text: row.text, sentAt: milliseconds(row.sentAt) });
const requestDto = (row) => ({ id: idNumber(row.id), customerId: idNumber(row.customerId), workerId: idNumber(row.workerId),
  workerUserId: idNumber(row.workerUserId), customerName: row.customerName, workerName: row.workerName, details: row.details,
  scheduledAt: milliseconds(row.scheduledAt), status: row.status, version: idNumber(row.version),
  statusChangedBy: idNumber(row.statusChangedBy), statusReason: row.statusReason, statusChangedAt: milliseconds(row.statusChangedAt),
  createdAt: milliseconds(row.createdAt), updatedAt: milliseconds(row.updatedAt) });
const reviewDto = (row) => ({ id: idNumber(row.id), workerId: idNumber(row.workerId), userId: idNumber(row.userId),
  requestId: idNumber(row.requestId), userName: row.userName, workerName: row.workerName, rating: row.rating, comment: row.comment,
  createdAt: milliseconds(row.createdAt), updatedAt: milliseconds(row.updatedAt) });
const emitNotification = (notification) => {
  if (notification) void realtimeHub.publish(notification.recipientUserId, 'notification.created', notification);
};
const publishConversation = (row) => realtimeHub.publishMany([row.customerId, row.workerUserId], 'conversation.updated', conversationDto(row));
const publishRequest = (result, event) => {
  const dto = requestDto(result.request);
  realtimeHub.publishMany([dto.customerId, dto.workerUserId], event, dto);
  result.notifications.forEach(emitNotification);
  return dto;
};

export const interactionService = {
  async conversations(userId, query) {
    const scope = ['conversations', userId];
    return pageResult(await repo.conversations(userId, query, decodePageCursor(query.cursor, scope)), query.limit, scope, conversationDto);
  },
  async conversation(id, userId) {
    const row = await repo.conversation(id, userId);
    if (!row) throw new AppError('NOT_FOUND', 404);
    return conversationDto(row);
  },
  async startConversation(userId, workerId) {
    const result = await repo.startConversation(userId, workerId);
    publishConversation(result.conversation);
    return { statusCode: result.created ? 201 : 200, data: conversationDto(result.conversation) };
  },
  async messages(id, userId, query) {
    const rows = await repo.messages(id, userId, query);
    const selected = rows.slice(0, query.limit);
    const nextBeforeNumber = rows.length > query.limit ? idNumber(selected.at(-1).messageNumber) : null;
    return { items: selected.reverse().map(messageDto), nextBeforeNumber };
  },
  async sendMessage(id, userId, text) {
    const result = await repo.sendMessage(id, userId, text);
    const message = messageDto(result.message);
    realtimeHub.publishMany([result.conversation.customerId, result.conversation.workerUserId], 'message.created', message);
    publishConversation(result.conversation);
    emitNotification(result.notification);
    return { statusCode: 201, data: message };
  },
  async deleteMessage(conversationId, messageId, userId, deleted) {
    const result = await repo.setMessageDeleted(conversationId, messageId, userId, deleted);
    realtimeHub.publishMany([result.conversation.customerId, result.conversation.workerUserId], deleted ? 'message.deleted' : 'message.restored', { id: messageId, conversationId });
    publishConversation(result.conversation);
    return { statusCode: 204 };
  },
  async deleteConversation(id, userId, deleted) {
    const result = await repo.setConversationDeleted(id, userId, deleted);
    if (deleted) {
      realtimeHub.publishMany(result.participants, 'conversation.deleted', { id });
      return { statusCode: 204 };
    }
    publishConversation(result.conversation);
    return conversationDto(result.conversation);
  },
  async createRequest(userId, input) {
    if (input.scheduledAt != null && input.scheduledAt <= Date.now()) throw new AppError('APPOINTMENT_IN_PAST', 400);
    return publishRequest(await repo.createRequest(userId, input), 'request.created');
  },
  async requests(userId, query) {
    const scope = ['requests', userId, query.as, query.status ?? null];
    return pageResult(await repo.requests(userId, query, decodePageCursor(query.cursor, scope)), query.limit, scope, requestDto);
  },
  async request(id, userId) {
    const row = await repo.request(id, userId);
    if (!row) throw new AppError('NOT_FOUND', 404);
    return requestDto(row);
  },
  async updateRequest(id, userId, input) { return publishRequest(await repo.updateRequest(id, userId, input), 'request.updated'); },
  async events(id, userId, query) {
    const rows = await repo.events(id, userId, query);
    return { items: rows.slice(0, query.limit).map((row) => ({ id: idNumber(row.id), requestId: idNumber(row.requestId),
      version: idNumber(row.version), fromStatus: row.fromStatus, toStatus: row.toStatus, actorId: idNumber(row.actorId),
      reason: row.reason, occurredAt: milliseconds(row.occurredAt) })),
    nextAfterVersion: rows.length > query.limit ? idNumber(rows[query.limit - 1].version) : null };
  },
  async deleteRequest(id, userId, deleted) {
    const result = await repo.setRequestDeleted(id, userId, deleted);
    if (deleted) {
      realtimeHub.publishMany(result.participants, 'request.deleted', { id });
      return { statusCode: 204 };
    }
    const request = requestDto(result.request);
    realtimeHub.publishMany(result.participants, 'request.restored', request);
    return request;
  },
  async reviews(workerId, userId, query) {
    const scope = ['reviews', userId, workerId];
    return pageResult(await repo.reviewList(workerId, userId, query, decodePageCursor(query.cursor, scope)), query.limit, scope, reviewDto);
  },
  async myReviews(userId, query) {
    const scope = ['myReviews', userId];
    return pageResult(await repo.myReviews(userId, query, decodePageCursor(query.cursor, scope)), query.limit, scope, reviewDto);
  },
  async addReview(workerId, userId, input) {
    const result = await repo.saveReview(workerId, userId, input);
    void realtimeHub.publish(result.workerUserId, 'worker.updated', { id: workerId });
    emitNotification(result.notification);
    return { statusCode: result.created ? 201 : 200, data: reviewDto(result.review) };
  },
  async editReview(id, userId, input) {
    const row = await repo.ownedReview(id, userId);
    if (!row) throw new AppError('NOT_FOUND', 404);
    const result = await repo.saveReview(row.workerId, userId, input, id);
    void realtimeHub.publish(result.workerUserId, 'worker.updated', { id: idNumber(row.workerId) });
    return reviewDto(result.review);
  },
  async deleteReview(id, userId, deleted) {
    const result = await repo.setReviewDeleted(id, userId, deleted);
    void realtimeHub.publish(result.workerUserId, 'worker.updated', { id: idNumber(result.workerId) });
    return deleted ? { statusCode: 204 } : reviewDto(result.review);
  }
};
