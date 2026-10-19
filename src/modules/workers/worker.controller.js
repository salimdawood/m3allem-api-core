import { workerService as service } from './worker.service.js';

export const workerController = {
  search: (req) => service.search(req.validated.query, req.user.id),
  nearby: (req) => service.nearby(req.validated.query, req.user.id),
  getById: (req) => service.getById(req.validated.params.id, req.user.id),
  mine: (req) => service.mine(req.user.id),
  create: async (req) => ({ statusCode: 201, data: await service.create(req.user.id, req.validated.body) }),
  update: (req) => service.update(req.user.id, req.validated.params.id, req.validated.body),
  restore: (req) => service.restore(req.user.id, req.validated.params.id, req.validated.body),
  delete: (req) => service.delete(req.user.id, req.validated.params.id),
  setDiscount: (req) => service.setDiscount(req.user.id, req.validated.params.id, req.validated.body),
  removeDiscount: (req) => service.removeDiscount(req.user.id, req.validated.params.id),
  setAvailability: (req) => service.setAvailability(req.user.id, req.validated.params.id, req.validated.body.isAvailable),
  setListing: (req) => service.setListing(req.user.id, req.validated.params.id, req.validated.body.isListed)
};
