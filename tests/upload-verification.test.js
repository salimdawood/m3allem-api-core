import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const database = `m3allem_upload_test_${Date.now()}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin';
function pg(executable, args) {
  const result = spawnSync(join(bin, executable), ['-h', '127.0.0.1', '-p', '55436', '-U', 'schema_test', ...args],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '', PGDATABASE: 'postgres' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('uploads and verification against finalized SQL', async (t) => {
  pg('createdb', [database]);
  for (const file of ['schema.sql', 'validation/fixture.sql']) pg('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database,
    '-f', join(root, 'database', file)]);
  const connection = `postgresql://schema_test@127.0.0.1:55436/${database}`;
  Object.assign(process.env, { DATABASE_URL: connection, DATABASE_URL_UNPOOLED: connection, NODE_ENV: 'test', APP_ENV: 'staging',
    JWT_ACCESS_SECRET: 'local-test-access-secret-32-characters-only', OTP_HMAC_SECRET: 'local-test-otp-secret-32-characters-only',
    OTP_FIXED_CODE: '111111', OTP_RATE_LIMIT_MAX: '10000', RATE_LIMIT_REDIS_URL: '', LOG_LEVEL: 'silent',
    S3_PROFILE_BUCKET: 'test-avatars', S3_IDENTITY_BUCKET: 'test-private-identities', S3_PUBLIC_BASE_URL: 'https://cdn.example.test',
    AUTO_APPROVE_VERIFICATION: 'true', AWS_EC2_METADATA_DISABLED: 'true',
    PRISMA_QUERY_ENGINE_LIBRARY: join(root, 'node_modules/@prisma/engines/query_engine-windows.dll.node') });
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/config/database.js');
  const { signAccessToken, signRegistrationToken } = await import('../src/utils/jwt.js');
  const { storageRepository: storage } = await import('../src/modules/uploads/storage.repository.js');
  const { AppError } = await import('../src/utils/AppError.js');
  const original = { put: storage.put, identityUrl: storage.identityUrl };
  const objects = new Map();
  let failPut = false;
  let afterPut;
  storage.put = async (location, buffer, contentType, hash, purpose) => {
    if (failPut) { failPut = false; throw new AppError('STORAGE_UNAVAILABLE', 503); }
    assert.equal(hash.toString('hex'), createHash('sha256').update(buffer).digest('hex'));
    objects.set(`${location.bucketName}/${location.objectKey}`, { buffer, contentType, purpose });
    if (afterPut) { const hook = afterPut; afterPut = undefined; await hook(location); }
  };
  storage.identityUrl = async (location) => `https://private.example.test/${location.objectKey}?signed-test=300`;
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  async function api(method, path, body, token, status = 200) {
    const response = await fetch(base + path, { method, headers: {
      ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    if (path.startsWith('/uploads') || path.startsWith('/admin/verifications') || path.startsWith('/me/worker/identity-documents'))
      assert.equal(response.headers.get('cache-control'), 'no-store');
    return data;
  }
  async function session(userId) {
    const row = await prisma.authSession.create({ data: { userId, expiresAt: new Date(Date.now() + 86400000) } });
    return signAccessToken(userId, row.id);
  }
  const ids = Object.fromEntries((await prisma.$queryRaw`SELECT name,id FROM schema_tests.ids`).map((r) => [r.name, Number(r.id)]));
  const owner = await session(ids.owner);
  const customer = await session(ids.customer);
  let admin = await session(ids.admin);
  const outsider = await session(ids.outsider);
  const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#5599bb' } }).withMetadata({ orientation: 6 }).png().toBuffer();
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  async function upload(token, purpose = 'identity-document', buffer = pdf, mime = 'application/pdf', status = 201) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), purpose === 'profile-image' ? 'avatar.png' : 'document.pdf');
    return api('POST', `/uploads/${purpose}`, form, token, status);
  }
  const submit = async (token, file) => api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: file.id }, token, 201);
  const workerDraft = { publicPhoneNumber: '+96170123456', categoryId: ids.category, workerTypeIds: [ids.worker_type],
    description: 'Fixture specialist', experienceYears: 1, services: [], startingPrice: null,
    workingHours: { timeZone: 'Asia/Beirut', shifts: [] }, location: { latitude: 33.89, longitude: 35.5 } };
  let avatar, first, second, third;
  try {
    await t.test('uploads require an existing authenticated account', async () => {
      const registration = await signRegistrationToken('+96170000888', 999);
      await upload(undefined, 'profile-image', image, 'image/png', 401);
      await upload(registration, 'profile-image', image, 'image/png', 401);
    });
    await t.test('avatar upload persists sanitized bytes, ownership, size and checksum', async () => {
      avatar = await upload(owner, 'profile-image', image, 'image/png');
      assert.equal(typeof avatar.id, 'number');
      assert.equal(avatar.status, 'READY');
      assert.equal(avatar.contentType, 'image/jpeg');
      assert.match(avatar.url, /^https:\/\/cdn.example.test\/profile\//);
      const row = await prisma.fileUpload.findUnique({ where: { id: avatar.id } });
      const saved = objects.get(`${row.bucketName}/${row.objectKey}`);
      assert.equal(Number(row.ownerUserId), ids.owner);
      assert.equal(Number(row.sizeBytes), saved.buffer.length);
      assert.equal(Buffer.from(row.sha256).toString('hex'), createHash('sha256').update(saved.buffer).digest('hex'));
      assert.equal((await sharp(saved.buffer).metadata()).exif, undefined);
      assert.equal(row.storageDeletedAt, null);
      assert.ok(row.cleanupAfter);
      assert.equal(Object.hasOwn(avatar, 'objectKey'), false);
    });
    await t.test('avatar attachment uses upload ID and protects live attachments', async () => {
      await api('GET', `/uploads/${avatar.id}`, undefined, customer, 404);
      await api('PATCH', '/me', { profileImageUploadId: avatar.id }, owner);
      assert.equal((await api('GET', `/uploads/${avatar.id}`, undefined, customer)).url, avatar.url);
      await api('DELETE', `/uploads/${avatar.id}`, undefined, owner, 409);
      await api('PATCH', '/me', { profileImageUploadId: avatar.id }, customer, 400);
      assert.equal((await prisma.fileUpload.findUnique({ where: { id: avatar.id } })).cleanupAfter, null);
      await api('PATCH', '/me', { profileImageUploadId: null }, owner);
    });
    await t.test('upload soft deletion preserves bytes and restoration retains identity', async () => {
      await api('DELETE', `/uploads/${avatar.id}`, undefined, customer, 404);
      await api('DELETE', `/uploads/${avatar.id}`, undefined, owner, 204);
      await api('GET', `/uploads/${avatar.id}`, undefined, owner, 404);
      const row = await prisma.fileUpload.findUnique({ where: { id: avatar.id } });
      assert.ok(row.deletedAt);
      assert.equal(row.storageDeletedAt, null);
      assert.ok(objects.has(`${row.bucketName}/${row.objectKey}`));
      assert.equal((await api('POST', `/uploads/${avatar.id}/restore`, {}, owner)).id, avatar.id);
    });
    await t.test('invalid files, multipart fields and oversized bodies are rejected', async () => {
      await upload(owner, 'profile-image', pdf, 'image/png', 415);
      await upload(owner, 'identity-document', Buffer.from('%PDF-1.4 truncated'), 'application/pdf', 400);
      await upload(owner, 'profile-image', Buffer.from('not an image'), 'image/png', 415);
      await upload(owner, 'profile-image', Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png', 413);
      const form = new FormData(); form.append('unexpected', 'value'); form.append('file', new Blob([image], { type: 'image/png' }), 'a.png');
      await api('POST', '/uploads/profile-image', form, owner, 400);
    });
    await t.test('storage failure leaves a retained failed record without becoming ready', async () => {
      failPut = true;
      await upload(owner, 'identity-document', pdf, 'application/pdf', 503);
      const failed = (await api('GET', '/uploads', undefined, owner)).items.find((row) => row.status === 'FAILED');
      assert.equal(failed.failureCode, 'STORAGE_WRITE_FAILED');
      await api('POST', `/uploads/${failed.id}/restore`, {}, owner, 409);
      const raw = await prisma.fileUpload.findUnique({ where: { id: failed.id } });
      assert.equal(raw.uploadedAt, null);
      assert.equal(raw.sha256, null);
    });
    await t.test('private uploads have no public URL and cannot be read by unrelated users/admins', async () => {
      const file = await upload(owner);
      assert.equal(Object.hasOwn(file, 'url'), false);
      await api('GET', `/uploads/${file.id}`, undefined, customer, 404);
      await api('GET', `/uploads/${file.id}`, undefined, admin, 404);
      assert.match((await api('GET', `/uploads/${file.id}`, undefined, owner)).url, /^https:\/\/private.example.test/);
      first = await submit(owner, file);
      assert.equal(first.status, 'PENDING'); // Even with legacy AUTO_APPROVE_VERIFICATION=true.
      assert.equal(first.reviewedBy, null);
      assert.equal(first.submissionNumber, 2);
      assert.equal(first.isCurrent, true);
      await api('GET', `/workers/${ids.worker}`, undefined, customer, 404);
    });
    await t.test('identity submission requires an unused ready owned identity upload', async () => {
      const foreign = await upload(customer);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: foreign.id }, owner, 400);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: avatar.id }, owner, 400);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: first.uploadId }, owner, 409);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', storageReference: 'arbitrary/private/key' }, owner, 400);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: String(first.uploadId) }, owner, 400);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: foreign.id }, customer, 404);
      const pending = (await prisma.$queryRaw`INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
        VALUES(${ids.owner},'IDENTITY_DOCUMENT','test-private-identities','pending-test.pdf') RETURNING id`)[0];
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: Number(pending.id) }, owner, 400);
    });
    await t.test('queue returns only current pending submissions and signs documents on demand', async () => {
      await api('GET', '/admin/verifications', undefined, customer, 403);
      const queue = await api('GET', '/admin/verifications', undefined, admin);
      assert.deepEqual(queue.items.map((d) => d.id), [first.id]);
      assert.equal(queue.items[0].workerName, 'Fixture worker');
      assert.equal(Object.hasOwn(queue.items[0], 'documentUrl'), false);
      const document = await api('GET', `/admin/verifications/${first.id}/document`, undefined, admin);
      assert.equal(document.expiresIn, 300);
      assert.match(document.url, /^https:\/\/private.example.test/);
    });
    await t.test('new submissions supersede pending history without mutating it', async () => {
      second = await submit(owner, await upload(owner));
      assert.equal(second.submissionNumber, 3);
      const queue = await api('GET', '/admin/verifications', undefined, admin);
      assert.deepEqual(queue.items.map((d) => d.id), [second.id]);
      assert.equal((await api('GET', '/me/worker/identity-documents/current', undefined, owner)).id, second.id);
      const history = (await api('GET', '/me/worker/identity-documents', undefined, owner)).items;
      assert.equal(history.find((d) => d.id === first.id).isCurrent, false);
      assert.equal(history.find((d) => d.id === first.id).status, 'PENDING');
      await api('POST', `/admin/verifications/${first.id}/approve`, {}, admin, 409);
      await api('GET', `/admin/verifications/${first.id}/document`, undefined, admin, 409);
    });
    await t.test('approval records the authenticated admin and enqueues one durable notification', async () => {
      await api('POST', '/devices', { fcmToken: 'identity-review-owner-device' }, owner, 204);
      await api('POST', `/admin/verifications/${second.id}/approve`, { reviewedBy: ids.customer }, admin, 400);
      await api('POST', `/admin/verifications/${second.id}/approve`, {}, admin, 204);
      const current = await api('GET', '/me/worker/identity-documents/current', undefined, owner);
      assert.equal(current.status, 'VERIFIED');
      assert.equal(current.reviewedBy, ids.admin);
      assert.ok(current.reviewedAt);
      const notifications = await prisma.notification.findMany({ where: { workerId: ids.worker, type: 'VERIFICATION_UPDATE' } });
      assert.equal(notifications.length, 1);
      assert.equal(Number(notifications[0].recipientUserId), ids.owner);
      assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: notifications[0].id, status: 'PENDING' } }), 1);
      await api('POST', `/admin/verifications/${second.id}/approve`, {}, admin, 409);
      await api('GET', `/workers/${ids.worker}`, undefined, customer);
    });
    await t.test('rejecting a new submission removes public verification and records the reason', async () => {
      third = await submit(owner, await upload(owner));
      await api('GET', `/workers/${ids.worker}`, undefined, customer, 404);
      await api('POST', `/admin/verifications/${third.id}/reject`, { reason: '   ' }, admin, 400);
      await api('POST', `/admin/verifications/${third.id}/reject`, { reason: 'Image is unreadable' }, admin, 204);
      const current = await api('GET', '/me/worker/identity-documents/current', undefined, owner);
      assert.equal(current.status, 'REJECTED');
      assert.equal(current.rejectionReason, 'Image is unreadable');
      await api('POST', `/admin/verifications/${third.id}/approve`, {}, admin, 409);
    });
    await t.test('deleting the newest submission does not fall back to old verification', async () => {
      await api('DELETE', `/uploads/${third.uploadId}`, undefined, owner, 409);
      await api('DELETE', `/me/worker/identity-documents/${third.id}`, undefined, customer, 404);
      await api('DELETE', `/me/worker/identity-documents/${third.id}`, undefined, owner, 204);
      await api('GET', '/me/worker/identity-documents/current', undefined, owner, 404);
      assert.equal((await api('GET', '/me/worker', undefined, owner)).verificationStatus, 'NOT_SUBMITTED');
      assert.ok((await prisma.identityDocument.findUnique({ where: { id: third.id } })).deletedAt);
      await api('DELETE', `/uploads/${third.uploadId}`, undefined, owner, 204);
      const raw = await prisma.fileUpload.findUnique({ where: { id: third.uploadId } });
      assert.ok(objects.has(`${raw.bucketName}/${raw.objectKey}`));
      assert.equal(raw.storageDeletedAt, null);
      await api('POST', `/uploads/${third.uploadId}/restore`, {}, owner);
      await api('POST', '/me/worker/identity-documents', { type: 'PASSPORT', uploadId: third.uploadId }, owner, 409);
    });
    await t.test('submission and upload lists use bounded numeric pagination', async () => {
      const all = await api('GET', '/me/worker/identity-documents', undefined, owner);
      const firstPage = await api('GET', '/me/worker/identity-documents?limit=1', undefined, owner);
      assert.equal(typeof firstPage.nextAfterId, 'number');
      const next = await api('GET', `/me/worker/identity-documents?afterId=${firstPage.nextAfterId}`, undefined, owner);
      assert.deepEqual([...firstPage.items, ...next.items].map((d) => d.id), all.items.map((d) => d.id));
      await api('GET', '/uploads?limit=201', undefined, owner, 400);
      await api('GET', '/admin/verifications?afterId=not-a-number', undefined, admin, 400);
    });
    await t.test('admins cannot review their own submission or obtain a review link for it', async () => {
      await api('POST', '/workers', workerDraft, admin, 201);
      const own = await submit(admin, await upload(admin));
      await api('POST', `/admin/verifications/${own.id}/approve`, {}, admin, 403);
      await api('GET', `/admin/verifications/${own.id}/document`, undefined, admin, 403);
      assert.equal((await api('GET', '/admin/verifications', undefined, admin)).items.some((d) => d.id === own.id), false);
    });
    await t.test('concurrent review decisions allow one immutable outcome and one notification', async () => {
      const doc = await submit(owner, await upload(owner));
      const responses = await Promise.all(['approve', 'reject'].map((action) => fetch(base + `/admin/verifications/${doc.id}/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify(action === 'approve' ? {} : { reason: 'Concurrent rejection' })
      })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409]);
      const current = await prisma.identityDocument.findUnique({ where: { id: doc.id } });
      assert.ok(['VERIFIED', 'REJECTED'].includes(current.status));
      assert.equal(await prisma.notification.count({ where: { workerId: ids.worker, type: 'VERIFICATION_UPDATE' } }), 3);
    });
    await t.test('repository rechecks admin authority inside the decision transaction', async () => {
      const doc = await submit(owner, await upload(owner));
      await prisma.user.update({ where: { id: ids.admin }, data: { isAdmin: false } });
      const { verificationRepository } = await import('../src/modules/verification/verification.repository.js');
      await assert.rejects(verificationRepository.review(doc.id, ids.admin, true), (e) => e.code === 'FORBIDDEN');
      await api('POST', `/admin/verifications/${doc.id}/approve`, {}, admin, 401);
      await prisma.user.update({ where: { id: ids.admin }, data: { isAdmin: true } });
      admin = await session(ids.admin);
    });
    await t.test('tombstone during storage write cannot produce a ready visible file', async () => {
      let id;
      afterPut = async (location) => {
        const row = await prisma.fileUpload.findUnique({ where: { bucketName_objectKey: location } });
        id = Number(row.id);
        await api('DELETE', `/uploads/${id}`, undefined, outsider, 204);
      };
      await upload(outsider, 'identity-document', pdf, 'application/pdf', 409);
      const row = await prisma.fileUpload.findUnique({ where: { id } });
      assert.ok(row.deletedAt);
      assert.equal(row.status, 'FAILED');
      assert.equal(row.failureCode, 'UPLOAD_FINALIZATION_FAILED');
      assert.ok(objects.has(`${row.bucketName}/${row.objectKey}`));
    });
    await t.test('account deletion during upload retains failed metadata and stored bytes', async () => {
      const user = await prisma.user.create({ data: { phoneNumber: '+96170000888', fullName: 'Leaving uploader' } });
      const token = await session(user.id);
      let location;
      afterPut = async (value) => { location = value; await api('DELETE', '/me', undefined, token, 204); };
      await upload(token, 'identity-document', pdf, 'application/pdf', 401);
      const row = await prisma.fileUpload.findUnique({ where: { bucketName_objectKey: location } });
      assert.ok(row.deletedAt);
      assert.equal(row.status, 'FAILED');
      assert.equal(row.storageDeletedAt, null);
      assert.ok(objects.has(`${row.bucketName}/${row.objectKey}`));
    });
    console.log(`Validated isolated database: ${database}`);
  } finally {
    storage.put = original.put; storage.identityUrl = original.identityUrl;
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
