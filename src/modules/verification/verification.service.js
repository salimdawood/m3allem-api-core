import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { storageRepository } from '../uploads/storage.repository.js';
import { verificationRepository as repo } from './verification.repository.js';
import { realtimeHub } from '../realtime/hub.js';

const dto = (doc) => ({ id: idNumber(doc.id), workerId: idNumber(doc.workerId), uploadId: idNumber(doc.uploadId),
  workerName: doc.workerName,
  submissionNumber: idNumber(doc.submissionNumber), type: doc.type, status: doc.status, isCurrent: doc.isCurrent === true,
  submittedAt: doc.submittedAt.getTime(), reviewedAt: doc.reviewedAt?.getTime() ?? null,
  reviewedBy: doc.reviewedBy == null ? null : idNumber(doc.reviewedBy), rejectionReason: doc.rejectionReason });
const page = (rows, limit) => ({ items: rows.slice(0, limit).map(dto), nextAfterId: rows.length > limit ? idNumber(rows[limit - 1].id) : null });
export const verificationService = {
  async submit(userId, input) {
    const row = await repo.submit(userId, input);
    void realtimeHub.publish(userId, 'worker.updated', { id: idNumber(row.workerId), verificationStatus: 'PENDING' });
    return dto(row);
  },
  async current(userId) {
    const doc = await repo.current(userId);
    if (!doc) throw new AppError('NOT_FOUND', 404);
    return dto(doc);
  },
  async history(userId, query) { return page(await repo.history(userId, query), query.limit); },
  async pending(adminId, query) { return page(await repo.pending(adminId, query), query.limit); },
  async document(documentId, adminId) {
    const file = await repo.documentForReview(documentId, adminId);
    return { url: await storageRepository.identityUrl(file), expiresIn: 300 };
  },
  async review(documentId, adminId, approved, reason) {
    const result = await repo.review(documentId, adminId, approved, reason);
    void realtimeHub.publish(result.userId, 'worker.updated', { id: idNumber(result.workerId), verificationStatus: approved ? 'VERIFIED' : 'REJECTED' });
    // SQL creates durable per-device deliveries. The legacy direct push path
    // would duplicate that work and still uses the old UUID contract.
    void realtimeHub.publish(result.userId, 'notification.created', result.notification);
    return { statusCode: 204 };
  },
  async delete(documentId, userId) {
    const result = await repo.softDelete(documentId, userId);
    void realtimeHub.publish(userId, 'worker.updated', { id: idNumber(result.workerId), verificationStatus: result.verificationStatus });
    return { statusCode: 204 };
  }
};
