import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
export const signAccessToken = (userId, sessionId) => new SignJWT({ sid: String(sessionId), tokenType: 'access' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(String(userId)).setIssuer(env.JWT_ISSUER)
  .setAudience(env.JWT_AUDIENCE).setIssuedAt().setExpirationTime('15m').sign(key);
export const signRegistrationToken = (phoneNumber, challengeId) => new SignJWT({ tokenType: 'registration', phoneNumber, challengeId: String(challengeId) })
  .setProtectedHeader({ alg: 'HS256' }).setIssuer(env.JWT_ISSUER).setAudience(env.JWT_AUDIENCE)
  .setIssuedAt().setExpirationTime('5m').sign(key);
export const verifyToken = (token) => jwtVerify(token, key, {
  algorithms: ['HS256'], issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE
});
