import { Router } from 'express';
import { tryCatch } from '../../utils/tryCatch.js';
import { catalogController } from './catalog.controller.js';

const router = Router();
router.get('/', tryCatch(catalogController.getCatalog));
router.get('/banners', tryCatch(catalogController.getBanners));
export default router;
