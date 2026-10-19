import { verificationService as service } from './verification.service.js';
export const verificationController = {
  submit: async (req) => ({ statusCode: 201, data: await service.submit(req.user.id, req.validated.body) }),
  current: (req) => service.current(req.user.id),
  history: (req) => service.history(req.user.id, req.validated.query),
  delete: (req) => service.delete(req.validated.params.documentId, req.user.id),
  pending: (req) => service.pending(req.user.id, req.validated.query),
  document: (req) => service.document(req.validated.params.documentId, req.user.id),
  approve: (req) => service.review(req.validated.params.documentId, req.user.id, true),
  reject: (req) => service.review(req.validated.params.documentId, req.user.id, false, req.validated.body.reason)
};
