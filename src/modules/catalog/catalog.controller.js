import { catalogService } from './catalog.service.js';

export const catalogController = {
  getCatalog: (req) => catalogService.catalogResponse(req.get('accept-language') ?? 'en',req.get('if-none-match')),
  getBanners: (req) => catalogService.getBanners(req.get('accept-language') ?? 'en')
};
