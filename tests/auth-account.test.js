import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

// Never use .env/DATABASE_URL. This suite only creates a fresh local test DB.
const database = `m3allem_backend_test_${Date.now()}`;
const bin = process.env.POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin';
const connection = `postgresql://schema_test@127.0.0.1:55436/${database}`;
const root = fileURLToPath(new URL('../', import.meta.url));
function pg(executable, args) {
  const result = spawnSync(join(bin, executable), ['-h', '127.0.0.1', '-p', '55436', '-U', 'schema_test', ...args],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '', PGDATABASE: 'postgres' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('auth and account routes against finalized SQL', async (t) => {
  pg('createdb', [database]);
  for (const file of ['schema.sql', 'validation/fixture.sql'])
    pg('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', join(root, 'database', file)]);
  Object.assign(process.env, { DATABASE_URL: connection, DATABASE_URL_UNPOOLED: connection, NODE_ENV: 'test', APP_ENV: 'staging',
    JWT_ACCESS_SECRET: 'local-test-access-secret-32-characters-only',
    OTP_HMAC_SECRET: 'local-test-otp-secret-32-characters-only', OTP_FIXED_CODE: '111111',
    OTP_RATE_LIMIT_MAX: '10000', RATE_LIMIT_REDIS_URL: '', LOG_LEVEL: 'silent',
    PRISMA_QUERY_ENGINE_LIBRARY: join(root, 'node_modules/@prisma/engines/query_engine-windows.dll.node') });
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/config/database.js');
  const { signAccessToken, verifyToken } = await import('../src/utils/jwt.js');
  const { idNumber, jsonReplacer } = await import('../src/utils/id.js');
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const { attachRealtime } = await import('../src/modules/realtime/realtime.js');
  const { WebSocket } = await import('ws');
  const wss = attachRealtime(server);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  async function api(method, path, body, token, status = 200) {
    const response = await fetch(base + path, { method, headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function login(phoneNumber) {
    const challenge = await api('POST', '/auth/otp/send', { phoneNumber });
    return api('POST', '/auth/otp/verify', { phoneNumber, challengeId: challenge.challengeId, code: '111111' });
  }
  async function session(userId) {
    const expiresAt = new Date(Date.now() + 86400000);
    return prisma.$transaction(async (db) => {
      const row = await db.authSession.create({ data: { userId, expiresAt } });
      const refreshToken = randomBytes(48).toString('base64url');
      await db.$executeRaw`INSERT INTO refresh_tokens(session_id,token_hash,expires_at)
        VALUES(${row.id},${createHash('sha256').update(refreshToken).digest()},${expiresAt})`;
      return { accessToken: await signAccessToken(userId, row.id), refreshToken, sessionId: row.id };
    });
  }
  const ids = Object.fromEntries((await prisma.$queryRaw`SELECT name,id FROM schema_tests.ids`).map((r) => [r.name, idNumber(r.id)]));
  try {
    await t.test('all 29 Prisma models read the finalized table mappings', async () => {
      const { Prisma } = await import('@prisma/client');
      assert.equal(Prisma.dmmf.datamodel.models.length, 29);
      for (const model of Prisma.dmmf.datamodel.models) {
        assert.ok(model.fields.some((field) => field.name === 'deletedAt'), model.name);
        for (const field of model.fields.filter((field) => field.isId)) assert.equal(field.type, 'BigInt', `${model.name}.${field.name}`);
        await prisma[model.name[0].toLowerCase() + model.name.slice(1)].findMany({ take: 1 });
      }
    });
    const customerLogin = await login('+96170000002');
    const customer = customerLogin.tokens.accessToken;
    const admin = (await login('+96170000004')).tokens.accessToken;
    const owner = (await login('+96170000001')).tokens.accessToken;

    await t.test('IDs are JSON numbers, worker capability replaces exclusive roles', async () => {
      assert.equal(typeof customerLogin.user.id, 'number');
      assert.equal(customerLogin.user.isWorker, false);
      assert.equal(Object.hasOwn(customerLogin.user, 'role'), false);
      assert.equal((await api('GET', '/me', undefined, owner)).isWorker, true);
      const { payload } = await verifyToken(customer);
      assert.equal(typeof payload.sub, 'string'); // JWT standard, not a SQL ID type.
      assert.equal(Object.hasOwn(payload, 'isAdmin'), false);
      assert.ok(payload.sid);
      assert.throws(() => idNumber(9007199254740993n));
      assert.throws(() => JSON.stringify({ id: 9007199254740993n }, jsonReplacer));
      assert.equal(JSON.stringify({ count: 0n }, jsonReplacer), '{"count":0}');
    });
    await t.test('registration has numeric identity and consumes a single-use proof', async () => {
      const proof = await login('+96170000101');
      const registered = await api('POST', '/auth/register', { fullName: 'New account' }, proof.registrationToken, 201);
      assert.equal(typeof registered.user.id, 'number');
      assert.equal(registered.user.isWorker, false);
      await api('POST', '/auth/register', { fullName: 'Replay' }, proof.registrationToken, 401);
      await api('POST', '/auth/register', { fullName: 'Legacy', role: 'WORKER' }, proof.registrationToken, 400);
      await api('POST', '/auth/register', { fullName: 'Legacy', profileImageUrl: 'https://example.com/a.jpg' }, proof.registrationToken, 400);
    });
    await t.test('OTP resend throttling and failed attempts persist through HTTP errors', async () => {
      const phoneNumber = '+96170000102';
      const sent = await api('POST', '/auth/otp/send', { phoneNumber });
      await api('POST', '/auth/otp/send', { phoneNumber }, undefined, 429);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const error = await api('POST', '/auth/otp/verify', { phoneNumber, challengeId: sent.challengeId, code: '222222' }, undefined, 400);
        assert.equal(error.error.code, attempt < 5 ? 'INVALID_OTP' : 'OTP_EXPIRED');
      }
      const row = await prisma.otpChallenge.findUnique({ where: { id: sent.challengeId } });
      assert.equal(row.attempts, 5);
      assert.ok(row.invalidatedAt);
      await api('POST', '/auth/otp/verify', { phoneNumber, challengeId: sent.challengeId, code: '111111' }, undefined, 400);
    });
    await t.test('OTP proof binds destination and exact challenge', async () => {
      const sent = await api('POST', '/auth/otp/send', { phoneNumber: '+96170000103' });
      await api('POST', '/auth/otp/verify', { phoneNumber: '+96170000104', challengeId: sent.challengeId, code: '111111' }, undefined, 400);
      await api('POST', '/auth/otp/verify', { phoneNumber: '+96170000103', challengeId: String(sent.challengeId), code: '111111' }, undefined, 400);
      await api('POST', '/auth/otp/verify', { phoneNumber: '+96170000103', challengeId: sent.challengeId, code: '111111' });
      await api('POST', '/auth/otp/verify', { phoneNumber: '+96170000103', challengeId: sent.challengeId, code: '111111' }, undefined, 400);
    });
    await t.test('refresh rotation and reuse revoke only that session family', async () => {
      const first = await session(ids.customer);
      const second = await session(ids.customer);
      const rotated = await api('POST', '/auth/refresh', { refreshToken: first.refreshToken });
      await api('GET', '/me', undefined, rotated.accessToken);
      await api('POST', '/auth/refresh', { refreshToken: first.refreshToken }, undefined, 401);
      await api('GET', '/me', undefined, rotated.accessToken, 401);
      await api('POST', '/auth/refresh', { refreshToken: rotated.refreshToken }, undefined, 401);
      await api('GET', '/me', undefined, second.accessToken);
    });
    await t.test('concurrent refresh reuse revocation remains committed', async () => {
      const first = await session(ids.customer);
      const responses = await Promise.all([1, 2].map(() => fetch(base + '/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: first.refreshToken })
      })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
      assert.ok((await prisma.authSession.findUnique({ where: { id: first.sessionId } })).revokedAt);
    });
    await t.test('logout invalidates access immediately and retains device rows', async () => {
      const current = await session(ids.customer);
      await api('POST', '/devices', { fcmToken: 'fixture-customer-device' }, current.accessToken, 204);
      await api('POST', '/auth/logout', { fcmToken: 'fixture-customer-device' }, current.accessToken, 204);
      await api('GET', '/me', undefined, current.accessToken, 401);
      assert.ok((await prisma.device.findFirst({ where: { fcmToken: 'fixture-customer-device' } })).deletedAt);
    });
    await t.test('WebSocket handshake and logout use current session state', { timeout: 5000 }, async () => {
      const current = await session(ids.customer);
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/realtime', { headers: { authorization: `Bearer ${current.accessToken}` } });
      const hello = await new Promise((resolve, reject) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
        ws.once('error', reject);
      });
      assert.equal(hello.data.userId, ids.customer);
      const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
      await api('POST', '/auth/logout', {}, current.accessToken, 204);
      assert.equal(await closed, 4401);
      const rejected = new WebSocket(base.replace('http:', 'ws:') + '/realtime', { headers: { authorization: `Bearer ${current.accessToken}` } });
      rejected.on('error', () => {});
      const status = await new Promise((resolve) => rejected.once('unexpected-response', (_req, response) => {
        response.resume(); resolve(response.statusCode); rejected.terminate();
      }));
      assert.equal(status, 401);
    });
    await t.test('revoked WebSocket receives no later published account data', { timeout: 5000 }, async () => {
      const current = await session(ids.customer);
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/realtime', { headers: { authorization: `Bearer ${current.accessToken}` } });
      await new Promise((resolve, reject) => { ws.once('message', resolve); ws.once('error', reject); });
      let messages = 0;
      ws.on('message', () => messages++);
      const closed = new Promise((resolve) => ws.once('close', resolve));
      await prisma.authSession.update({ where: { id: current.sessionId }, data: { revokedAt: new Date(), revocationReason: 'TEST_REVOCATION' } });
      const { realtimeHub } = await import('../src/modules/realtime/hub.js');
      await realtimeHub.publish(ids.customer, 'private-data', { id: 1 });
      await closed;
      assert.equal(messages, 0);
    });
    await t.test('profile name is canonical, URL and UUID inputs rejected', async () => {
      const changed = await api('PATCH', '/me', { fullName: 'Canonical customer', location: { latitude: 33.8, longitude: 35.5 } }, customer);
      assert.equal(changed.fullName, 'Canonical customer');
      await api('PATCH', '/me', { profileImageUrl: 'https://example.com/a.jpg' }, customer, 400);
      await api('GET', '/users/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', undefined, customer, 400);
      const publicUser = await api('GET', `/users/${ids.customer}`, undefined, customer);
      assert.deepEqual(Object.keys(publicUser).sort(), ['fullName', 'id', 'profileImageUploadId']);
    });
    await t.test('avatar references require an owned ready profile-image upload', async () => {
      const upload = await prisma.$transaction(async (db) => {
        const row = (await db.$queryRaw`INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
          VALUES(${ids.customer},'PROFILE_IMAGE','test-avatars','customer/avatar.jpg') RETURNING id`)[0];
        await db.$executeRaw`UPDATE file_uploads SET status='READY',content_type='image/jpeg',size_bytes=100,
          sha256=decode(repeat('ab',32),'hex') WHERE id=${row.id}`;
        return Number(row.id);
      });
      assert.equal((await api('PATCH', '/me', { profileImageUploadId: upload }, customer)).profileImageUploadId, upload);
      await api('PATCH', '/me', { profileImageUploadId: upload }, owner, 400);
      await api('PATCH', '/me', { profileImageUploadId: ids.identity_upload }, owner, 400);
      await api('PATCH', '/me', { profileImageUploadId: null }, customer);
      const row = await prisma.fileUpload.findUnique({ where: { id: upload } });
      assert.equal(row.deletedAt, null);
      assert.equal(row.storageDeletedAt, null);
      assert.ok(row.cleanupAfter);
    });
    await t.test('settings upsert and soft-deleted settings restoration', async () => {
      const settings = { notificationsEnabled: false, reminderLeadMinutes: 15, language: 'ar' };
      await api('PUT', '/me/settings', settings, customer, 204);
      assert.deepEqual(await api('GET', '/me/settings', undefined, customer), settings);
      await prisma.userSettings.update({ where: { userId: ids.customer }, data: { deletedAt: new Date() } });
      await api('PUT', '/me/settings', { ...settings, language: 'en' }, customer, 204);
      assert.equal((await api('GET', '/me/settings', undefined, customer)).language, 'en');
    });
    await t.test('favorites tombstone and restore; worker cannot favorite self', async () => {
      await api('PUT', `/me/favorites/${ids.worker}`, {}, customer, 204);
      assert.deepEqual((await api('GET', '/me/favorites', undefined, customer)).workerIds, [ids.worker]);
      await api('DELETE', `/me/favorites/${ids.worker}`, {}, customer, 204);
      assert.deepEqual((await api('GET', '/me/favorites', undefined, customer)).workerIds, []);
      await api('PUT', `/me/favorites/${ids.worker}`, {}, customer, 204);
      assert.equal((await api('GET', '/me/favorites/workers', undefined, customer))[0].id, ids.worker);
      await api('PUT', `/me/favorites/${ids.worker}`, {}, owner, 404);
    });
    await t.test('contact history uses typed targets and CALL has no reference', async () => {
      await api('POST', '/me/contact-history', { workerId: ids.worker, interactionType: 'CALL' }, customer, 201);
      const rows = await api('GET', '/me/contact-history', undefined, customer);
      assert.ok(rows.some((r) => r.interactionType === 'CALL' && r.requestId === null && r.conversationId === null));
      await api('POST', '/me/contact-history', { workerId: ids.worker, interactionType: 'CALL', referenceId: 'arbitrary' }, customer, 400);
    });
    await t.test('notification reads use read_at and preserve typed targets', async () => {
      const row = (await prisma.$queryRaw`INSERT INTO notifications(recipient_user_id,type,title,body,conversation_id)
        VALUES(${ids.customer},'NEW_MESSAGE','Test','Message',${ids.conversation}) RETURNING id`)[0];
      await api('POST', `/notifications/${row.id}/read`, {}, customer, 204);
      const notification = (await api('GET', '/notifications', undefined, customer)).find((r) => r.id === Number(row.id));
      assert.ok(notification.readAt);
      assert.equal(notification.conversationId, ids.conversation);
      await api('POST', '/notifications/read-all', {}, customer, 204);
    });
    await t.test('suspension revokes old sessions; reactivation requires fresh login', async () => {
      const target = await session(ids.outsider);
      await api('PATCH', `/admin/users/${ids.outsider}/status`, { status: 'SUSPENDED', reason: 'Fixture moderation' }, customer, 403);
      await api('PATCH', `/admin/users/${ids.outsider}/status`, { status: 'SUSPENDED', reason: 'Fixture moderation' }, admin, 204);
      await api('GET', '/me', undefined, target.accessToken, 401);
      await api('PATCH', `/admin/users/${ids.outsider}/status`, { status: 'ACTIVE' }, admin, 204);
      await api('GET', '/me', undefined, target.accessToken, 401);
      await api('GET', '/me', undefined, (await session(ids.outsider)).accessToken);
    });
    await t.test('admin removal revokes access before token expiry', async () => {
      const user = await prisma.user.create({ data: { phoneNumber: '+96170000120', fullName: 'Temporary admin', isAdmin: true } });
      const current = await session(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { isAdmin: false } });
      await api('PATCH', `/admin/users/${ids.outsider}/status`, { status: 'SUSPENDED', reason: 'Stale admin' }, current.accessToken, 401);
    });
    await t.test('phone change revokes sessions and preserves independent public phone', async () => {
      const newPhoneNumber = '+96170000111';
      const sent = await api('POST', '/me/phone/request', { newPhoneNumber }, owner);
      await api('POST', '/me/phone/confirm', { newPhoneNumber, challengeId: sent.challengeId, code: '111111' }, owner);
      await api('GET', '/me', undefined, owner, 401);
      assert.equal((await prisma.workerProfile.findUnique({ where: { id: ids.worker } })).publicPhoneNumber, '+96170000001');
    });
    await t.test('recovery email confirmation revokes sessions; recovery response hides existence', async () => {
      const email = 'customer@example.test';
      const sent = await api('POST', '/me/recovery-email/request', { email }, customer);
      await api('POST', '/me/recovery-email/confirm', { email, challengeId: sent.challengeId, code: '111111' }, customer);
      await api('GET', '/me', undefined, customer, 401);
      const known = await api('POST', '/auth/recovery/request', { email });
      const unknown = await api('POST', '/auth/recovery/request', { email: 'unknown@example.test' });
      assert.deepEqual(Object.keys(known), Object.keys(unknown));
      assert.equal(Object.hasOwn(known, 'developerCode'), false);
      const recovered = await api('POST', '/auth/recovery/verify', { email, code: '111111' });
      assert.equal(recovered.user.id, ids.customer);
      await api('POST', '/auth/recovery/verify', { email, code: '111111' }, undefined, 400);
    });
    await t.test('account deletion retains rows, cascades tombstones, reserves credentials', async () => {
      const target = await session(ids.other);
      await api('POST', '/devices', { fcmToken: 'fixture-deleted-device' }, target.accessToken, 204);
      await api('DELETE', '/me', undefined, target.accessToken, 204);
      await api('GET', '/me', undefined, target.accessToken, 401);
      const row = await prisma.user.findUnique({ where: { id: ids.other } });
      assert.equal(row.accountStatus, 'DELETED');
      assert.ok(row.deletedAt);
      assert.ok((await prisma.device.findFirst({ where: { fcmToken: 'fixture-deleted-device' } })).deletedAt);
      const sent = await api('POST', '/auth/otp/send', { phoneNumber: row.phoneNumber });
      await api('POST', '/auth/otp/verify', { phoneNumber: row.phoneNumber, challengeId: sent.challengeId, code: '111111' }, undefined, 403);
    });
    console.log(`Validated isolated database: ${database}`);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
