import { authService } from './auth.service.js';
export const authController = {
  sendOtp: (req) => authService.requestLoginCode(req.validated.body),
  verifyOtp: (req) => authService.verifyLoginCode(req.validated.body),
  register: async (req) => ({ statusCode: 201, data: await authService.register(req.validated.body, req.get('authorization')?.replace(/^Bearer\s+/i, '')) }),
  refresh: (req) => authService.refresh(req.validated.body),
  logout: (req) => authService.logout({ ...req.validated.body, userId: req.user.id, sessionId: req.user.sessionId }),
  me: (req) => authService.me(req.user.id),
  recover: (req) => authService.requestRecovery(req.validated.body),
  verifyRecovery: (req) => authService.verifyRecovery(req.validated.body),
  requestPhone: (req) => authService.requestPhoneChange(req.user.id,req.validated.body),
  confirmPhone: (req) => authService.confirmPhoneChange(req.user.id,req.validated.body),
  requestEmail: (req) => authService.requestRecoveryEmail(req.user.id,req.validated.body),
  confirmEmail: (req) => authService.confirmRecoveryEmail(req.user.id,req.validated.body)
};
