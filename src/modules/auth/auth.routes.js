import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { otpRateLimits } from '../../middlewares/rate-limit.js';
import { tryCatch } from '../../utils/tryCatch.js';
import { authController as c } from './auth.controller.js';
import { schemas } from './auth.validation.js';

const router = Router();
router.post('/otp/send', validate(schemas.phone), ...otpRateLimits, tryCatch(c.sendOtp));
router.post('/otp/verify', validate(schemas.verify), ...otpRateLimits, tryCatch(c.verifyOtp));
router.post('/register', validate(schemas.register), tryCatch(c.register));
router.post('/refresh', validate(schemas.refresh), tryCatch(c.refresh));
router.post('/logout', authenticate, validate(schemas.logout), tryCatch(c.logout));
router.post('/recovery/request', validate(schemas.recovery), ...otpRateLimits, tryCatch(c.recover));
router.post('/recovery/verify', validate(schemas.recoveryVerify), ...otpRateLimits, tryCatch(c.verifyRecovery));
router.get('/me', authenticate, tryCatch(c.me));
export default router;
