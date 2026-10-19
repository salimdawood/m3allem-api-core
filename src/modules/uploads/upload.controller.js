import { uploadService } from './upload.service.js';
export const uploadController = {
  list: (req) => uploadService.list(req.user.id, req.validated.query),
  profileImage: async (req) => ({ statusCode: 201, data: await uploadService.profileImage(req.user.id, req.file) }),
  identityDocument: async (req) => ({ statusCode: 201, data: await uploadService.identityDocument(req.user.id, req.file) }),
  get: (req) => uploadService.get(req.validated.params.id, req.user.id),
  delete: (req) => uploadService.delete(req.validated.params.id, req.user.id),
  restore: (req) => uploadService.restore(req.validated.params.id, req.user.id)
};
