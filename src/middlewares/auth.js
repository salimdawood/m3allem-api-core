import { AppError } from '../utils/AppError.js';
import { verifyToken } from '../utils/jwt.js';
import { idNumber } from '../utils/id.js';
import { authRepository } from '../modules/auth/auth.repository.js';

export async function accessIdentity(token) {
  const { payload } = await verifyToken(token);
  if (payload.tokenType !== 'access' || !payload.sub || !payload.sid) throw new AppError('NOT_AUTHENTICATED', 401);
  const identity = await authRepository.sessionIdentity(idNumber(payload.sub), idNumber(payload.sid));
  if (!identity) throw new AppError('NOT_AUTHENTICATED', 401);
  return { id: idNumber(identity.id), sessionId: idNumber(identity.sessionId),
    isAdmin: identity.isAdmin, isWorker: identity.isWorker, expiresAt: payload.exp * 1000 };
}

export const authenticate = async (req, _res, next) => {
  try {
    const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new AppError('NOT_AUTHENTICATED', 401);
    req.user = await accessIdentity(token);
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError('NOT_AUTHENTICATED', 401));
  }
};

export const requireAdmin = (req, _res, next) => {
  if (!req.user?.isAdmin) return next(new AppError('FORBIDDEN', 403));
  next();
};
