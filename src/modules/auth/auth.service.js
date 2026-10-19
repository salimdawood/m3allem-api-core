import { createHash, createHmac, randomInt, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { signAccessToken, signRegistrationToken, verifyToken } from '../../utils/jwt.js';
import { authRepository as repo } from './auth.repository.js';
import { userDto } from './user.dto.js';
import { otpDelivery } from './otp-delivery.js';
import { realtimeHub } from '../realtime/hub.js';
import { logger } from '../../config/logger.js';

const phone = (value) => {
  const digits = String(value ?? '').replace(/[\s()+-]/g, '').replace(/^00/, '');
  const national = digits.startsWith('961') ? digits.slice(3).replace(/^0/, '') : digits.replace(/^0/, '');
  if (!/^\d{7,8}$/.test(national)) throw new AppError('INVALID_PHONE', 400);
  return `+961${national}`;
};
const email = (value) => String(value ?? '').trim().toLowerCase();
const active = (user) => user && !user.deletedAt && user.accountStatus === 'ACTIVE';
const hashToken = (token) => createHash('sha256').update(token).digest();
const hashOtp = (flow, nonce, code) => createHmac('sha256', env.OTP_HMAC_SECRET)
  .update(JSON.stringify([String(flow.flowId ?? flow.id), flow.purpose, flow.destination,
    flow.userId == null ? null : String(flow.userId), Buffer.from(nonce).toString('hex'), code])).digest();
const sessionExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000);
const tokenPair = async (user, db) => {
  const expiresAt = sessionExpiry();
  const session = await repo.createSession(user.id, expiresAt, db);
  const refreshToken = randomBytes(48).toString('base64url');
  await repo.createRefreshToken(session.id, hashToken(refreshToken), expiresAt, db);
  return { accessToken: await signAccessToken(user.id, session.id), refreshToken, expiresIn: 900 };
};
const genericRecovery = (destination) => ({ destination, codeLength: 6, resendAfterSeconds: 30 });

async function sendOtp(purpose, destination, userId = null) {
  const code = env.OTP_FIXED_CODE ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  const nonce = randomBytes(16);
  const saved = await repo.transaction(async (db) => {
    const flow = await repo.flow(purpose, destination, userId, db);
    if (flow.rateLimited) return null;
    return repo.issueChallenge(flow.id, nonce, hashOtp(flow, nonce, code), db);
  });
  if (!saved) throw new AppError('RATE_LIMITED', 429);
  if (env.APP_ENV !== 'staging' || env.DELIVERY_MODE === 'mock') {
    try { await otpDelivery.send(destination, code); }
    catch (error) { await repo.invalidateChallenge(saved.id); throw error; }
  }
  return { ...genericRecovery(destination), challengeId: idNumber(saved.id),
    ...(env.APP_ENV === 'staging' ? { developerCode: code } : {}) };
}

async function withOtp(purpose, destination, input, userId, apply) {
  const result = await repo.transaction(async (db) => {
    const challenge = purpose === 'ACCOUNT_RECOVERY'
      ? await repo.currentRecoveryChallenge(destination, userId, db)
      : await repo.challenge(input.challengeId, purpose, destination, userId, db);
    if (!challenge) return { error: 'OTP_EXPIRED' };
    const outcome = await repo.consumeChallenge(challenge, hashOtp(challenge, challenge.nonce, input.code), db);
    // Return failure so attempt counters/invalidation commit before the API error.
    if (outcome !== 'OK') return { error: outcome };
    return { value: await apply(db, challenge) };
  });
  if (result.error) throw new AppError(result.error, 400);
  return result.value;
}

export const authService = {
  requestLoginCode: (input) => sendOtp('LOGIN', phone(input.phoneNumber)),
  verifyLoginCode(input) {
    const destination = phone(input.phoneNumber);
    return withOtp('LOGIN', destination, input, null, async (db, challenge) => {
      const user = await repo.userByPhone(destination, db);
      if (!user) return { status: 'NEW_USER', phoneNumber: destination,
        registrationToken: await signRegistrationToken(destination, challenge.id) };
      if (!active(user)) throw new AppError('ACCOUNT_UNAVAILABLE', 403);
      return { status: 'EXISTING_USER', user: userDto(user), tokens: await tokenPair(user, db) };
    });
  },
  async register(input, registrationToken) {
    let payload;
    try { ({ payload } = await verifyToken(registrationToken)); }
    catch { throw new AppError('NOT_AUTHENTICATED', 401); }
    if (payload.tokenType !== 'registration' || !payload.phoneNumber || !payload.challengeId)
      throw new AppError('NOT_AUTHENTICATED', 401);
    try {
      const proofId = idNumber(payload.challengeId);
      return await repo.transaction(async (db) => {
        const proof = await repo.challenge(proofId, 'LOGIN', phone(payload.phoneNumber), null, db);
        if (!proof?.consumedAt) throw new AppError('NOT_AUTHENTICATED', 401);
        const user = await repo.createUser({ phoneNumber: phone(payload.phoneNumber), fullName: input.fullName.trim(),
          nationality: input.nationality?.toUpperCase() ?? null,
          latitude: input.location?.latitude ?? null, longitude: input.location?.longitude ?? null,
          address: input.location?.address ?? null }, db);
        await repo.retireRegistrationProof(proofId, db);
        return { user: userDto(user), tokens: await tokenPair(user, db) };
      });
    } catch (error) {
      if (error.code === 'P2002') throw new AppError('PHONE_IN_USE', 409);
      throw error;
    }
  },
  async refresh(input) {
    const refreshToken = randomBytes(48).toString('base64url');
    const result = await repo.transaction(async (db) => {
      const rotation = await repo.rotateRefreshToken(hashToken(input.refreshToken), hashToken(refreshToken), sessionExpiry(), db);
      if (rotation.outcome !== 'OK') return null; // Commit reuse revocation.
      const identity = await repo.sessionIdentity(rotation.userId, rotation.sessionId, db);
      if (!identity) return null;
      return { accessToken: await signAccessToken(identity.id, identity.sessionId), refreshToken, expiresIn: 900 };
    });
    if (!result) throw new AppError('NOT_AUTHENTICATED', 401);
    return result;
  },
  async logout(input) {
    await repo.transaction(async (db) => {
      await repo.revokeSession(input.sessionId, input.userId, 'LOGOUT', db);
      if (input.fcmToken) await repo.deleteDevice(input.userId, input.fcmToken, db);
    });
    realtimeHub.disconnect(input.userId, input.sessionId);
    return { statusCode: 204 };
  },
  async me(userId) {
    const user = await repo.userById(userId);
    if (!user) throw new AppError('NOT_AUTHENTICATED', 401);
    return userDto(user);
  },
  async requestRecovery(input) {
    const destination = email(input.email);
    const user = await repo.userByRecoveryEmail(destination);
    if (active(user)) {
      try { await sendOtp('ACCOUNT_RECOVERY', destination, user.id); }
      catch (error) { if (error.code !== 'RATE_LIMITED') logger.warn({ code: error.code }, 'Account recovery issuance failed'); }
    }
    return genericRecovery(destination);
  },
  async verifyRecovery(input) {
    const destination = email(input.email);
    const user = await repo.userByRecoveryEmail(destination);
    if (!active(user)) throw new AppError('INVALID_OTP', 400);
    try {
      return await withOtp('ACCOUNT_RECOVERY', destination, input, user.id, async (db) => {
        await repo.revokeTokenFamily(user.id, db);
        return { user: userDto(user), tokens: await tokenPair(user, db) };
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 400) throw new AppError('INVALID_OTP', 400);
      throw error;
    }
  },
  async requestPhoneChange(userId, input) {
    const next = phone(input.newPhoneNumber);
    const user = await repo.userById(userId);
    if (!user) throw new AppError('NOT_AUTHENTICATED', 401);
    if (next === user.phoneNumber) throw new AppError('PHONE_UNCHANGED', 400);
    if (await repo.userByPhone(next)) throw new AppError('PHONE_IN_USE', 409);
    return sendOtp('PHONE_CHANGE', next, userId);
  },
  async confirmPhoneChange(userId, input) {
    const next = phone(input.newPhoneNumber);
    try {
      return await withOtp('PHONE_CHANGE', next, input, userId, async (db) =>
        userDto(await repo.updateUser(userId, { phoneNumber: next }, db)));
    } catch (error) {
      if (error.code === 'P2002') throw new AppError('PHONE_IN_USE', 409);
      throw error;
    }
  },
  async requestRecoveryEmail(userId, input) {
    const destination = email(input.email);
    const owner = await repo.userByRecoveryEmail(destination);
    if (owner && idNumber(owner.id) !== userId) throw new AppError('INVALID_EMAIL', 400);
    return sendOtp('RECOVERY_EMAIL', destination, userId);
  },
  async confirmRecoveryEmail(userId, input) {
    const destination = email(input.email);
    try {
      return await withOtp('RECOVERY_EMAIL', destination, input, userId, async (db) =>
        userDto(await repo.updateUser(userId, { recoveryEmail: destination }, db)));
    } catch (error) {
      if (error.code === 'P2002') throw new AppError('INVALID_EMAIL', 400);
      throw error;
    }
  }
};
