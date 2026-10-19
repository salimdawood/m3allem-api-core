import {Router} from 'express';
import {tryCatch} from '../../utils/tryCatch.js';
import {healthController as c} from './health.controller.js';
const r=Router();
r.get('/health/live',tryCatch(c.live));r.get('/health/ready',tryCatch(c.ready));r.get('/v1/health',tryCatch(c.apiHealth));r.get('/v1/config/app',tryCatch(c.appConfig));
export default r;
