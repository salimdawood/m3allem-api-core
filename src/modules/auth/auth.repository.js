import { prisma } from '../../config/database.js';

const active = { deletedAt: null, accountStatus: 'ACTIVE' };
const capabilities = { workerProfiles: { select: { id: true, deletedAt: true } } };
export const authRepository = {
  transaction: (callback) => prisma.$transaction(callback),
  // Include tombstones in credential checks: identifiers remain reserved.
  userByPhone: (phoneNumber, db = prisma) => db.user.findUnique({ where: { phoneNumber }, include: capabilities }),
  userByRecoveryEmail: (recoveryEmail, db = prisma) => db.user.findUnique({ where: { recoveryEmail }, include: capabilities }),
  userById: (id, db = prisma) => db.user.findFirst({ where: { id, ...active }, include: capabilities }),
  updateUser: (id, data, db = prisma) => db.user.update({ where: { id, ...active }, data, include: capabilities }),
  createUser: (data, db = prisma) => db.user.create({ data, include: capabilities }),
  async flow(purpose, destination, userId, db) {
    return (await db.$queryRaw`INSERT INTO otp_flows(purpose,destination,user_id)
      VALUES(${purpose}::otp_purpose,${destination},${userId}::bigint)
      ON CONFLICT(purpose,destination,user_id) WHERE deleted_at IS NULL
      DO UPDATE SET destination=EXCLUDED.destination
      RETURNING id,purpose,destination,user_id AS "userId",
        (last_issued_at IS NOT NULL AND clock_timestamp()<last_issued_at+interval '30 seconds') AS "rateLimited"`)[0];
  },
  async issueChallenge(flowId, nonce, hash, db) {
    return (await db.$queryRaw`INSERT INTO otp_challenges(flow_id,issuance_nonce,code_hash)
      VALUES(${flowId},${nonce},${hash}) RETURNING id`)[0];
  },
  invalidateChallenge: (id) => prisma.$executeRaw`UPDATE active_otp_challenges SET invalidated_at=clock_timestamp()
    WHERE id=${id} AND consumed_at IS NULL AND superseded_at IS NULL AND invalidated_at IS NULL`,
  async challenge(id, purpose, destination, userId, db) {
    const rows = await db.$queryRaw`SELECT f.id FROM active_otp_flows f
      JOIN active_otp_challenges c ON c.flow_id=f.id
      WHERE c.id=${id} AND f.purpose=${purpose}::otp_purpose AND f.destination=${destination}
      AND f.user_id IS NOT DISTINCT FROM ${userId}::bigint FOR UPDATE OF f`;
    if (!rows.length) return null;
    return (await db.$queryRaw`SELECT c.id,c.flow_id AS "flowId",c.issuance_nonce AS nonce,
      c.consumed_at AS "consumedAt",f.purpose,f.destination,f.user_id AS "userId"
      FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id
      WHERE c.id=${id} FOR UPDATE OF c`)[0] ?? null;
  },
  async consumeChallenge(challenge, hash, db) {
    return (await db.$queryRaw`SELECT consume_otp_challenge(${challenge.id},${challenge.flowId},${hash}) AS outcome`)[0].outcome;
  },
  async currentRecoveryChallenge(destination, userId, db) {
    const flows = await db.$queryRaw`SELECT id FROM active_otp_flows WHERE purpose='ACCOUNT_RECOVERY'
      AND destination=${destination} AND user_id=${userId} FOR UPDATE`;
    if (!flows.length) return null;
    return (await db.$queryRaw`SELECT c.id,c.flow_id AS "flowId",c.issuance_nonce AS nonce,
      f.purpose,f.destination,f.user_id AS "userId" FROM active_otp_challenges c
      JOIN active_otp_flows f ON f.id=c.flow_id WHERE f.id=${flows[0].id}
      ORDER BY c.id DESC LIMIT 1 FOR UPDATE OF c`)[0] ?? null;
  },
  retireRegistrationProof: (id, db) => db.$executeRaw`UPDATE active_otp_challenges SET deleted_at=clock_timestamp() WHERE id=${id}`,
  createSession: (userId, expiresAt, db) => db.authSession.create({ data: { userId, expiresAt } }),
  createRefreshToken: (sessionId, hash, expiresAt, db) => db.$executeRaw`INSERT INTO refresh_tokens(session_id,token_hash,expires_at)
    VALUES(${sessionId},${hash},${expiresAt})`,
  async rotateRefreshToken(hash, newHash, expiresAt, db) {
    return (await db.$queryRaw`SELECT outcome,session_id AS "sessionId",user_id AS "userId"
      FROM rotate_refresh_token(${hash},${newHash},${expiresAt})`)[0];
  },
  revokeSession: (sessionId, userId, reason, db = prisma) => db.$executeRaw`UPDATE active_auth_sessions
    SET revoked_at=clock_timestamp(),revocation_reason=${reason}
    WHERE id=${sessionId} AND user_id=${userId} AND revoked_at IS NULL`,
  revokeTokenFamily: (userId, db = prisma) => db.$executeRaw`UPDATE active_auth_sessions
    SET revoked_at=clock_timestamp(),revocation_reason='ACCOUNT_RECOVERY'
    WHERE user_id=${userId} AND revoked_at IS NULL`,
  async sessionIdentity(userId, sessionId, db = prisma) {
    return (await db.$queryRaw`SELECT u.id,u.is_admin AS "isAdmin",s.id AS "sessionId",
      EXISTS(SELECT 1 FROM active_worker_profiles w WHERE w.user_id=u.id) AS "isWorker"
      FROM active_users u JOIN active_auth_sessions s ON s.user_id=u.id
      WHERE u.id=${userId} AND s.id=${sessionId} AND u.account_status='ACTIVE'
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`)[0] ?? null;
  },
  deleteDevice: (userId, fcmToken, db = prisma) => db.$executeRaw`UPDATE active_devices SET deleted_at=clock_timestamp()
    WHERE user_id=${userId} AND fcm_token=${fcmToken}`
};
