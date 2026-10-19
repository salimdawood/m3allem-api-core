import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const database = `m3allem_interaction_test_${Date.now()}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin';
function pg(executable, args) {
  const result = spawnSync(join(bin, executable), ['-h', '127.0.0.1', '-p', '55436', '-U', 'schema_test', ...args],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '', PGDATABASE: 'postgres' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('conversations, requests and reviews against finalized SQL', async (t) => {
  pg('createdb', [database]);
  for (const file of ['schema.sql', 'validation/fixture.sql']) pg('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database,
    '-f', join(root, 'database', file)]);
  const connection = `postgresql://schema_test@127.0.0.1:55436/${database}`;
  Object.assign(process.env, { DATABASE_URL: connection, DATABASE_URL_UNPOOLED: connection, NODE_ENV: 'test', APP_ENV: 'staging',
    JWT_ACCESS_SECRET: 'local-test-access-secret-32-characters-only', OTP_HMAC_SECRET: 'local-test-otp-secret-32-characters-only',
    OTP_FIXED_CODE: '111111', OTP_RATE_LIMIT_MAX: '10000', RATE_LIMIT_REDIS_URL: '', LOG_LEVEL: 'silent', AWS_EC2_METADATA_DISABLED: 'true',
    PRISMA_QUERY_ENGINE_LIBRARY: join(root, 'node_modules/@prisma/engines/query_engine-windows.dll.node') });
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/config/database.js');
  const { signAccessToken } = await import('../src/utils/jwt.js');
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  async function api(method, path, body, token, status = 200) {
    const response = await fetch(base + path, { method, headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function session(userId) {
    const row = await prisma.authSession.create({ data: { userId, expiresAt: new Date(Date.now() + 86400000) } });
    return signAccessToken(userId, row.id);
  }
  const ids = Object.fromEntries((await prisma.$queryRaw`SELECT name,id FROM schema_tests.ids`).map((r) => [r.name, Number(r.id)]));
  const customer = await session(ids.customer), owner = await session(ids.owner), other = await session(ids.other),
    outsider = await session(ids.outsider), admin = await session(ids.admin);
  let messages = [], request, review;
  async function completed(token) {
    let row = await api('POST', '/service-requests', { workerId: ids.worker }, token, 201);
    row = await api('PATCH', `/service-requests/${row.id}`, { status: 'ACCEPTED', version: row.version }, owner);
    return api('PATCH', `/service-requests/${row.id}`, { status: 'COMPLETED', version: row.version }, owner);
  }
  async function assertRating() {
    const rows = await prisma.review.findMany({ where: { workerId: ids.worker, deletedAt: null } });
    const expected = rows.length ? Math.round(rows.reduce((sum, r) => sum + r.rating, 0) / rows.length * 10) / 10 : 0;
    const worker = await prisma.workerProfile.findUnique({ where: { id: ids.worker } });
    assert.equal(Number(worker.rating), expected);
    assert.equal(Number(worker.ratingCount), rows.length);
  }
  try {
    await t.test('conversation start is idempotent and contact history is created once', async () => {
      const first = await api('POST', '/conversations', { workerId: ids.worker }, customer);
      assert.equal(first.id, ids.conversation);
      assert.equal(first.customerId, ids.customer);
      assert.equal(Object.hasOwn(first, 'customerPhone'), false);
      await api('POST', '/conversations', { workerId: ids.worker }, customer);
      assert.equal(await prisma.contactHistory.count({ where: { conversationId: ids.conversation } }), 1);
      await api('POST', '/conversations', { workerId: ids.worker }, owner, 403);
      await api('POST', '/conversations', { workerId: String(ids.worker) }, customer, 400);
    });
    await t.test('only fixed participants can read or send; admin has no chat bypass', async () => {
      await api('GET', `/conversations/${ids.conversation}`, undefined, owner);
      await api('GET', `/conversations/${ids.conversation}`, undefined, outsider, 404);
      await api('GET', `/conversations/${ids.conversation}/messages`, undefined, admin, 404);
      await api('POST', `/conversations/${ids.conversation}/messages`, { text: 'Not a participant' }, outsider, 404);
      await api('POST', `/conversations/${ids.conversation}/messages`, { text: '   ' }, customer, 400);
    });
    await t.test('concurrent starts reuse the conversation key without duplicating history', async () => {
      const responses = await Promise.all([1, 2].map(() => fetch(base + '/conversations', { method: 'POST',
        headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' }, body: JSON.stringify({ workerId: ids.worker })
      })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
      const conversation = await prisma.conversation.findUnique({ where: { customerId_workerId: { customerId: ids.other, workerId: ids.worker } } });
      assert.equal(await prisma.contactHistory.count({ where: { conversationId: conversation.id } }), 1);
    });
    await t.test('messages get monotonic numbers and one durable typed notification each', async () => {
      await api('POST', '/devices', { fcmToken: 'interaction-owner-device' }, owner, 204);
      for (let i = 1; i <= 4; i++) messages.push(await api('POST', `/conversations/${ids.conversation}/messages`, { text: ` message ${i} ` }, customer, 201));
      assert.deepEqual(messages.map((m) => m.messageNumber), [1, 2, 3, 4]);
      assert.equal(messages[0].senderId, ids.customer);
      const summary = await api('GET', `/conversations/${ids.conversation}`, undefined, owner);
      assert.equal(summary.lastMessage, 'message 4');
      assert.equal(summary.lastMessageId, messages[3].id);
      const notifications = await prisma.notification.findMany({ where: { conversationId: ids.conversation, type: 'NEW_MESSAGE' } });
      assert.equal(notifications.length, 4);
      assert.ok(notifications.every((n) => n.requestId === null && n.body === 'You received a new message.'));
      assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: { in: notifications.map((n) => n.id) } } }), 4);
    });
    await t.test('message pagination uses exclusive sequence bounds with ascending page contents', async () => {
      const latest = await api('GET', `/conversations/${ids.conversation}/messages?limit=2`, undefined, customer);
      assert.deepEqual(latest.items.map((m) => m.messageNumber), [3, 4]);
      assert.equal(latest.nextBeforeNumber, 3);
      const older = await api('GET', `/conversations/${ids.conversation}/messages?limit=2&beforeNumber=3`, undefined, owner);
      assert.deepEqual(older.items.map((m) => m.messageNumber), [1, 2]);
      assert.equal(older.nextBeforeNumber, null);
      await api('GET', `/conversations/${ids.conversation}/messages?before=123456789`, undefined, owner, 400);
    });
    await t.test('message tombstones preserve sequence and derived last-message summaries', async () => {
      const last = messages[3];
      await api('DELETE', `/conversations/${ids.conversation}/messages/${last.id}`, undefined, owner, 404);
      await api('DELETE', `/conversations/${ids.conversation}/messages/${last.id}`, undefined, customer, 204);
      assert.ok((await prisma.message.findUnique({ where: { id: last.id } })).deletedAt);
      assert.equal((await api('GET', `/conversations/${ids.conversation}`, undefined, customer)).lastMessageId, messages[2].id);
      const newer = await api('POST', `/conversations/${ids.conversation}/messages`, { text: 'After tombstone' }, customer, 201);
      assert.equal(newer.messageNumber, 5);
      await api('POST', `/conversations/${ids.conversation}/messages/${last.id}/restore`, {}, customer, 204);
      assert.equal((await api('GET', `/conversations/${ids.conversation}`, undefined, customer)).lastMessageId, newer.id);
    });
    await t.test('concurrent message sends allocate unique sequence numbers', async () => {
      const results = await Promise.all([customer, owner].map((token) => api('POST', `/conversations/${ids.conversation}/messages`, { text: 'Concurrent send' }, token, 201)));
      assert.deepEqual(results.map((r) => r.messageNumber).sort(), [6, 7]);
    });
    await t.test('starter controls conversation deletion; restore keeps messages explicitly tombstoned', async () => {
      await api('DELETE', `/conversations/${ids.conversation}`, undefined, owner, 403);
      await api('DELETE', `/conversations/${ids.conversation}`, undefined, customer, 204);
      await api('GET', `/conversations/${ids.conversation}`, undefined, owner, 404);
      await api('POST', '/conversations', { workerId: ids.worker }, customer, 409);
      assert.equal(await prisma.message.count({ where: { conversationId: ids.conversation, deletedAt: null } }), 0);
      const restored = await api('POST', `/conversations/${ids.conversation}/restore`, {}, customer);
      assert.equal(restored.id, ids.conversation);
      assert.equal(restored.lastMessage, null);
      assert.deepEqual((await api('GET', `/conversations/${ids.conversation}/messages`, undefined, customer)).items, []);
      await api('POST', `/conversations/${ids.conversation}/messages/${messages[0].id}/restore`, {}, customer, 204);
      assert.equal((await api('GET', `/conversations/${ids.conversation}`, undefined, owner)).lastMessageId, messages[0].id);
      assert.equal(await prisma.contactHistory.count({ where: { conversationId: ids.conversation, deletedAt: null } }), 1);
      assert.equal((await api('POST', `/conversations/${ids.conversation}/messages`, { text: 'Retained counter' }, customer, 201)).messageNumber, 8);
    });
    await t.test('new requests record original participants, actor and one history row', async () => {
      request = await api('POST', '/service-requests', { workerId: ids.worker, details: 'Repair the fixture', scheduledAt: Date.now() + 7200000 }, customer, 201);
      assert.equal(request.version, 1);
      assert.equal(request.statusChangedBy, ids.customer);
      assert.equal(request.workerUserId, ids.owner);
      assert.equal(Object.hasOwn(request, 'customerPhone'), false);
      assert.equal(await prisma.contactHistory.count({ where: { requestId: request.id } }), 1);
      const notifications = await prisma.notification.findMany({ where: { requestId: request.id } });
      assert.deepEqual(notifications.map((n) => n.type).sort(), ['SERVICE_REQUEST_RECEIVED', 'SERVICE_REQUEST_SENT']);
      assert.ok(notifications.every((n) => n.workerId === null));
      assert.equal(await prisma.scheduledReminder.count({ where: { requestId: request.id } }), 0);
    });
    await t.test('request creation and transitions reject wrong actors and legacy payloads', async () => {
      await api('POST', '/service-requests', { workerId: ids.worker }, owner, 403);
      await api('POST', '/service-requests', { workerId: ids.worker, scheduledAt: Date.now() - 1 }, customer, 400);
      await api('POST', '/service-requests', { workerId: ids.worker, details: '   ' }, customer, 400);
      await api('PATCH', `/service-requests/${request.id}`, { status: 'ACCEPTED', version: 1 }, customer, 409);
      await api('PATCH', `/service-requests/${request.id}`, { status: 'CANCELLED', version: 1 }, owner, 409);
      await api('PATCH', `/service-requests/${request.id}`, { status: 'ACCEPTED', version: 1 }, admin, 404);
      await api('PATCH', `/service-requests/${request.id}`, { status: 'ACCEPTED' }, owner, 400);
      await api('PATCH', `/service-requests/${request.id}`, { status: 'ACCEPTED', version: 1, details: 'Changed' }, owner, 400);
      await api('GET', `/service-requests/${request.id}/events`, undefined, outsider, 404);
      await api('DELETE', `/service-requests/${request.id}`, undefined, customer, 409);
    });
    await t.test('accept/complete creates exact event versions and SQL-managed reminders', async () => {
      request = await api('PATCH', `/service-requests/${request.id}`, { status: 'ACCEPTED', version: 1 }, owner);
      assert.equal(request.version, 2);
      assert.equal(request.statusChangedBy, ids.owner);
      assert.equal(await prisma.scheduledReminder.count({ where: { requestId: request.id, cancelledAt: null } }), 2);
      await api('PATCH', `/service-requests/${request.id}`, { status: 'COMPLETED', version: 1 }, owner, 409);
      request = await api('PATCH', `/service-requests/${request.id}`, { status: 'COMPLETED', version: 2 }, owner);
      assert.equal(request.version, 3);
      assert.equal(await prisma.scheduledReminder.count({ where: { requestId: request.id, cancelledAt: null } }), 0);
      const events = await api('GET', `/service-requests/${request.id}/events`, undefined, customer);
      assert.deepEqual(events.items.map((e) => [e.version, e.toStatus, e.actorId]), [[1, 'PENDING', ids.customer], [2, 'ACCEPTED', ids.owner], [3, 'COMPLETED', ids.owner]]);
      const first = await api('GET', `/service-requests/${request.id}/events?limit=1`, undefined, customer);
      assert.equal(first.nextAfterVersion, 1);
      assert.deepEqual((await api('GET', `/service-requests/${request.id}/events?afterVersion=1`, undefined, owner)).items.map((e) => e.version), [2, 3]);
    });
    await t.test('concurrent request decisions reject stale versions without extra events', async () => {
      const row = await api('POST', '/service-requests', { workerId: ids.worker }, customer, 201);
      const responses = await Promise.all(['ACCEPTED', 'DECLINED'].map((status) => fetch(base + `/service-requests/${row.id}`, {
        method: 'PATCH', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ status, version: 1 })
      })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      assert.equal(await prisma.serviceRequestEvent.count({ where: { requestId: row.id } }), 2);
    });
    await t.test('review requires the authenticated customer and its completed request', async () => {
      const pending = await api('POST', '/service-requests', { workerId: ids.worker }, customer, 201);
      await api('POST', `/workers/${ids.worker}/reviews`, { requestId: pending.id, rating: 5 }, customer, 409);
      await api('POST', `/workers/${ids.worker}/reviews`, { requestId: ids.other_request, rating: 5 }, customer, 409);
      await api('POST', `/workers/${ids.worker}/reviews`, { rating: 5 }, customer, 400);
      await api('POST', `/workers/${ids.worker}/reviews`, { requestId: ids.request, rating: 5 }, owner, 403);
      review = await api('POST', `/workers/${ids.worker}/reviews`, { requestId: ids.request, rating: 5, comment: 'Helpful' }, customer, 201);
      assert.equal(review.userId, ids.customer);
      await assertRating();
    });
    await t.test('review edits retain original proof and do not duplicate creation notifications', async () => {
      const edited = await api('POST', `/workers/${ids.worker}/reviews`, { requestId: ids.request, rating: 4, comment: 'Updated' }, customer);
      assert.equal(edited.id, review.id);
      assert.equal(edited.createdAt, review.createdAt);
      await api('POST', `/workers/${ids.worker}/reviews`, { requestId: request.id, rating: 5 }, customer, 409);
      await api('PATCH', `/reviews/${review.id}`, { rating: 3 }, other, 404);
      await api('PATCH', `/reviews/${review.id}`, { rating: 4, comment: '   ' }, customer);
      assert.equal((await prisma.review.findUnique({ where: { id: review.id } })).comment, null);
      assert.equal(await prisma.notification.count({ where: { workerId: ids.worker, type: 'NEW_REVIEW' } }), 1);
    });
    await t.test('rating aggregates stay consistent with concurrent authors and upserts', async () => {
      const otherReview = await api('POST', `/workers/${ids.worker}/reviews`, { requestId: ids.other_request, rating: 2 }, other, 201);
      const proof = await completed(outsider);
      const responses = await Promise.all([2, 5].map((rating) => fetch(base + `/workers/${ids.worker}/reviews`, {
        method: 'POST', headers: { authorization: `Bearer ${outsider}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: proof.id, rating })
      })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
      await Promise.all([[review.id, customer], [otherReview.id, other]].map(([id, token]) => api('PATCH', `/reviews/${id}`, { rating: 3 }, token)));
      await assertRating();
      assert.equal(await prisma.review.count({ where: { workerId: ids.worker, userId: ids.outsider, deletedAt: null } }), 1);
      assert.equal(await prisma.notification.count({ where: { workerId: ids.worker, type: 'NEW_REVIEW' } }), 3);
    });
    await t.test('review deletion/restoration retains IDs, eligibility and rating integrity', async () => {
      await api('DELETE', `/reviews/${review.id}`, undefined, other, 404);
      await api('DELETE', `/reviews/${review.id}`, undefined, customer, 204);
      assert.ok((await prisma.review.findUnique({ where: { id: review.id } })).deletedAt);
      await assertRating();
      const replacement = await api('POST', `/workers/${ids.worker}/reviews`, { requestId: ids.request, rating: 1 }, customer, 201);
      await api('POST', `/reviews/${review.id}/restore`, {}, customer, 409);
      await api('DELETE', `/reviews/${replacement.id}`, undefined, customer, 204);
      const restored = await api('POST', `/reviews/${review.id}/restore`, {}, customer);
      assert.equal(restored.id, review.id);
      assert.equal(restored.createdAt, review.createdAt);
      await assertRating();
    });
    await t.test('worker restoration reconciles reviews removed while the profile was deleted', async () => {
      const prior = await api('GET', '/me/worker', undefined, owner);
      await api('DELETE', `/workers/${ids.worker}`, undefined, owner, 204);
      await api('DELETE', `/reviews/${review.id}`, undefined, customer, 204);
      const body = { publicPhoneNumber: prior.publicPhoneNumber, whatsappNumber: prior.whatsappNumber,
        categoryId: prior.categoryId, workerTypeIds: prior.workerTypeIds, description: prior.description,
        experienceYears: prior.experienceYears, services: prior.services, startingPrice: prior.startingPrice,
        workingHours: prior.workingHours, location: prior.location, isAvailable: prior.isAvailable, isListed: prior.isListed };
      const restored = await api('POST', `/workers/${ids.worker}/restore`, body, owner);
      assert.equal(restored.verificationStatus, 'NOT_SUBMITTED');
      await assertRating();
      await api('POST', `/reviews/${review.id}/restore`, {}, customer);
      await assertRating();
      await prisma.$transaction(async (db) => {
        const upload = (await db.$queryRaw`INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
          VALUES(${ids.owner},'IDENTITY_DOCUMENT','test-private','restored-worker.pdf') RETURNING id`)[0];
        await db.$executeRaw`UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=100,
          sha256=decode(repeat('ab',32),'hex') WHERE id=${upload.id}`;
        const doc = (await db.$queryRaw`INSERT INTO identity_documents(worker_id,type,upload_id)
          VALUES(${ids.worker},'PASSPORT',${upload.id}) RETURNING id`)[0];
        await db.$executeRaw`UPDATE identity_documents SET status='VERIFIED',reviewed_by=${ids.admin} WHERE id=${doc.id}`;
      });
    });
    await t.test('reviews remain editable after unlisting; public reads follow profile visibility', async () => {
      await api('PUT', `/workers/${ids.worker}/listing`, { isListed: false }, owner);
      await api('GET', `/workers/${ids.worker}/reviews`, undefined, customer, 404);
      assert.ok((await api('GET', `/workers/${ids.worker}/reviews`, undefined, owner)).items.length);
      await api('PATCH', `/reviews/${review.id}`, { rating: 4 }, customer);
      assert.ok((await api('GET', '/me/reviews', undefined, customer)).items.some((r) => r.id === review.id));
      await api('PUT', `/workers/${ids.worker}/listing`, { isListed: true }, owner);
    });
    await t.test('terminal request deletion cascades tombstones; restore preserves event history', async () => {
      await api('DELETE', `/service-requests/${ids.request}`, undefined, owner, 403);
      await api('DELETE', `/service-requests/${ids.request}`, undefined, customer, 204);
      await api('GET', `/service-requests/${ids.request}`, undefined, owner, 404);
      assert.ok((await prisma.review.findUnique({ where: { id: review.id } })).deletedAt);
      await assertRating();
      const restored = await api('POST', `/service-requests/${ids.request}/restore`, {}, customer);
      assert.equal(restored.status, 'COMPLETED');
      assert.equal(restored.version, 3);
      assert.equal((await api('GET', `/service-requests/${ids.request}/events`, undefined, owner)).items.length, 3);
      assert.ok((await prisma.review.findUnique({ where: { id: review.id } })).deletedAt);
      await api('POST', `/reviews/${review.id}/restore`, {}, customer);
      await assertRating();
    });
    await t.test('collection cursors preserve microsecond ordering and are scoped to the caller/filters', async () => {
      await api('POST', '/conversations', { workerId: ids.worker }, outsider, 201);
      for (const [path, token] of [['/service-requests?as=customer', customer], ['/conversations?x=unused', owner], [`/workers/${ids.worker}/reviews`, customer]]) {
        const clean = path.replace('?x=unused', '');
        const all = await api('GET', clean, undefined, token);
        const paged = []; let cursor;
        do {
          const result = await api('GET', `${clean}${clean.includes('?') ? '&' : '?'}limit=1${cursor ? `&cursor=${cursor}` : ''}`, undefined, token);
          paged.push(...result.items); cursor = result.nextCursor;
          assert.ok(paged.length <= all.items.length);
        } while (cursor);
        assert.deepEqual(paged.map((r) => r.id), all.items.map((r) => r.id));
      }
      const first = await api('GET', '/service-requests?as=customer&limit=1', undefined, customer);
      await api('GET', `/service-requests?as=worker&cursor=${first.nextCursor}`, undefined, customer, 400);
      await api('GET', `/service-requests?as=customer&cursor=${first.nextCursor}`, undefined, other, 400);
      const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
      assert.match(decoded.at, /\.\d{6}Z$/);
      for (const at of ['2026-02-31T10:00:00.000000Z', ['2026-01-01T10:00:00.000000Z']]) {
        const forged = Buffer.from(JSON.stringify({ ...decoded, at })).toString('base64url');
        await api('GET', `/service-requests?as=customer&cursor=${forged}`, undefined, customer, 400);
      }
    });
    await t.test('worker-capable accounts can hire others and retain both request views', async () => {
      const profile = await api('POST', '/workers', { publicPhoneNumber: '+96170123456', categoryId: ids.category,
        workerTypeIds: [ids.worker_type], description: 'Other worker', experienceYears: 1, services: [], startingPrice: null,
        workingHours: { timeZone: 'Asia/Beirut', shifts: [] }, location: { latitude: 33.89, longitude: 35.5 } }, other, 201);
      await prisma.$transaction(async (db) => {
        const upload = (await db.$queryRaw`INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
          VALUES(${ids.other},'IDENTITY_DOCUMENT','test-private','other.pdf') RETURNING id`)[0];
        await db.$executeRaw`UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=100,sha256=decode(repeat('ab',32),'hex') WHERE id=${upload.id}`;
        const doc = (await db.$queryRaw`INSERT INTO identity_documents(worker_id,type,upload_id) VALUES(${profile.id},'PASSPORT',${upload.id}) RETURNING id`)[0];
        await db.$executeRaw`UPDATE identity_documents SET status='VERIFIED',reviewed_by=${ids.admin} WHERE id=${doc.id}`;
      });
      const hired = await api('POST', '/service-requests', { workerId: profile.id }, owner, 201);
      assert.equal(hired.customerId, ids.owner);
      assert.equal(hired.workerUserId, ids.other);
      assert.ok((await api('GET', '/service-requests?as=customer', undefined, owner)).items.some((r) => r.id === hired.id));
      assert.ok((await api('GET', '/service-requests?as=worker', undefined, owner)).items.some((r) => r.workerId === ids.worker));
    });
    await t.test('remaining participant can cancel after the worker account leaves', async () => {
      const historical = await api('POST', '/service-requests', { workerId: ids.worker }, customer, 201);
      await api('DELETE', '/me', undefined, owner, 204);
      assert.equal((await api('GET', `/service-requests/${historical.id}`, undefined, customer)).workerName, 'Fixture worker');
      const cancelled = await api('PATCH', `/service-requests/${historical.id}`, { status: 'CANCELLED', version: 1, reason: 'Worker unavailable' }, customer);
      assert.equal(cancelled.statusChangedBy, ids.customer);
      assert.equal(cancelled.statusReason, 'Worker unavailable');
      assert.equal(await prisma.notification.count({ where: { requestId: historical.id, recipientUserId: ids.owner, type: 'SERVICE_REQUEST_UPDATED' } }), 0);
      await api('GET', `/conversations/${ids.conversation}`, undefined, customer);
      await api('POST', `/conversations/${ids.conversation}/messages`, { text: 'Unavailable peer' }, customer, 409);
      await api('POST', '/service-requests', { workerId: ids.worker }, customer, 404);
    });
    console.log(`Validated isolated database: ${database}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
