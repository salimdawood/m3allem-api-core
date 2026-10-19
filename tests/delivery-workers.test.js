import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises';

const database = `m3allem_delivery_test_${Date.now()}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin';
function pg(executable, args) {
  const result = spawnSync(join(bin, executable), ['-h', '127.0.0.1', '-p', '55436', '-U', 'schema_test', ...args],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '', PGDATABASE: 'postgres' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
test('reminder and delivery workers against finalized SQL', async (t) => {
  pg('createdb', [database]);
  for (const file of ['schema.sql', 'validation/fixture.sql']) pg('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database,
    '-f', join(root, 'database', file)]);
  const connection = `postgresql://schema_test@127.0.0.1:55436/${database}`;
  Object.assign(process.env, { DATABASE_URL: connection, DATABASE_URL_UNPOOLED: connection, NODE_ENV: 'test', APP_ENV: 'staging',
    JWT_ACCESS_SECRET: 'local-test-access-secret-32-characters-only', OTP_HMAC_SECRET: 'local-test-otp-secret-32-characters-only',
    OTP_FIXED_CODE: '111111', OTP_RATE_LIMIT_MAX: '10000', RATE_LIMIT_REDIS_URL: '', LOG_LEVEL: 'silent',
    PUSH_DELIVERY_ENABLED: 'false', AWS_EC2_METADATA_DISABLED: 'true',
    PRISMA_QUERY_ENGINE_LIBRARY: join(root, 'node_modules/@prisma/engines/query_engine-windows.dll.node') });
  const { prisma } = await import('../src/config/database.js');
  const { notificationRepository: repo } = await import('../src/modules/notifications/notification.repository.js');
  const { createNotificationWorker } = await import('../src/modules/notifications/notification.service.js');
  const { reminderRepository } = await import('../src/jobs/reminder.repository.js');
  const { runReminderCycle } = await import('../src/jobs/reminder.job.js');
  const { startRecurringJob } = await import('../src/jobs/recurring-job.js');
  const { startPushJob } = await import('../src/jobs/push.job.js');
  const ids = Object.fromEntries((await prisma.$queryRaw`SELECT name,id FROM schema_tests.ids`).map((r) => [r.name, Number(r.id)]));
  let sequence = 300;
  async function customer() {
    const user = await prisma.user.create({ data: { phoneNumber: `+96170000${sequence++}`, fullName: 'Delivery fixture' } });
    await prisma.userSettings.create({ data: { userId: user.id } });
    return user;
  }
  async function makeDelivery() {
    const user = await customer();
    const device = await prisma.device.create({ data: { userId: user.id, fcmToken: `delivery-device-${sequence}` } });
    const conversation = (await prisma.$queryRaw`INSERT INTO conversations(customer_id,worker_id) VALUES(${user.id},${ids.worker}) RETURNING id`)[0];
    const notification = (await prisma.$queryRaw`INSERT INTO notifications(recipient_user_id,type,title,body,conversation_id)
      VALUES(${user.id},'NEW_MESSAGE','New message','You received a message.',${conversation.id}) RETURNING id`)[0];
    return { user, device, conversation, notification, delivery: await prisma.notificationDelivery.findFirst({ where: { notificationId: notification.id } }) };
  }
  async function makeReminder(minutes = 10) {
    const user = await customer();
    const device = await prisma.device.create({ data: { userId: user.id, fcmToken: `reminder-device-${sequence}` } });
    const request = (await prisma.$queryRaw`INSERT INTO service_requests(customer_id,worker_id,scheduled_at)
      VALUES(${user.id},${ids.worker},clock_timestamp()+make_interval(mins=>${minutes}::integer)) RETURNING id`)[0];
    await prisma.$executeRaw`UPDATE service_requests SET status='ACCEPTED',status_changed_by=${ids.owner} WHERE id=${request.id}`;
    return { user, device, request, candidate: (await reminderRepository.candidates()).find((r) => r.recipientUserId === user.id) };
  }
  const provider = (send = async () => 'firebase-message-id') => ({ ready: async () => {}, send });
  const worker = (adapter, options = {}) => createNotificationWorker({ provider: adapter, concurrency: 1, limit: 1, random: () => 0.5, ...options });
  async function expireClaim(id) {
    // Fixture-only clock travel. Production workers never disable triggers.
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
      await db.$executeRaw`UPDATE notification_deliveries SET last_attempt_at=clock_timestamp()-interval '2 minutes',
        lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=${id}`;
    });
  }
  async function pastAppointment(id) {
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
      await db.$executeRaw`UPDATE service_requests SET scheduled_at=clock_timestamp()-interval '1 second' WHERE id=${id}`;
    });
  }
  const row = (id) => prisma.notificationDelivery.findUnique({ where: { id } });
  async function check(name, fn) {
    await t.test(name, async () => {
      await prisma.$executeRaw`UPDATE active_service_requests SET status='CANCELLED',status_changed_by=customer_id
        WHERE status IN ('PENDING','ACCEPTED')`;
      await prisma.$executeRaw`UPDATE active_devices SET deleted_at=clock_timestamp()`;
      await prisma.$executeRaw`UPDATE active_notification_deliveries SET deleted_at=clock_timestamp()`;
      await fn();
    });
  }
  try {
    await check('concurrent reminder materialization creates one inbox item per reminder', async () => {
      const fixture = await makeReminder();
      const results = await Promise.all([runReminderCycle({ publish: async () => {} }), runReminderCycle({ publish: async () => {} })]);
      assert.equal(results.reduce((sum, value) => sum + value.created, 0), 2);
      const reminders = await prisma.scheduledReminder.findMany({ where: { requestId: fixture.request.id } });
      assert.equal(reminders.length, 2);
      assert.ok(reminders.every((r) => r.notificationId));
      assert.equal(await prisma.notification.count({ where: { requestId: fixture.request.id, type: 'APPOINTMENT_REMINDER' } }), 2);
      assert.equal(await prisma.notificationDelivery.count({ where: { recipientUserId: fixture.user.id, deletedAt: null } }), 1);
      assert.equal((await runReminderCycle({ publish: async () => {} })).created, 0);
    });
    await check('disabled, cancelled and elapsed appointments do not create reminders', async () => {
      const disabled = await makeReminder();
      await prisma.userSettings.update({ where: { userId: disabled.user.id }, data: { notificationsEnabled: false } });
      assert.equal(await reminderRepository.materialize(disabled.candidate), null);
      const cancelled = await makeReminder();
      await prisma.$executeRaw`UPDATE service_requests SET status='CANCELLED',status_changed_by=${cancelled.user.id} WHERE id=${cancelled.request.id}`;
      assert.equal(await reminderRepository.materialize(cancelled.candidate), null);
      const elapsed = await makeReminder();
      await pastAppointment(elapsed.request.id);
      assert.equal(await reminderRepository.materialize(elapsed.candidate), null);
      assert.ok((await prisma.scheduledReminder.findUnique({ where: { id: elapsed.candidate.id } })).cancelledAt);
    });
    await check('concurrent delivery claims skip locked rows and increment one claim version', async () => {
      const fixture = await makeDelivery();
      const claims = await Promise.all([repo.claimOne(), repo.claimOne()]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claimed = claims.find(Boolean);
      assert.equal(claimed.attempts, 1);
      assert.equal(claimed.claimVersion, 1n);
      assert.equal((await row(fixture.delivery.id)).status, 'PROCESSING');
    });
    await check('provider acceptance records SENT and typed string data without generic references', async () => {
      const fixture = await makeDelivery(); let payload;
      const result = await worker(provider(async (message) => { payload = message; return 'accepted/123'; })).runOnce();
      assert.equal(result.sent, 1);
      const delivered = await row(fixture.delivery.id);
      assert.equal(delivered.status, 'SENT');
      assert.equal(delivered.providerMessageId, 'accepted/123');
      assert.ok(delivered.sentAt);
      assert.equal(payload.token, fixture.device.fcmToken);
      assert.equal(payload.data.conversationId, String(fixture.conversation.id));
      assert.equal(payload.data.notificationId, String(fixture.notification.id));
      assert.equal(Object.hasOwn(payload.data, 'referenceId'), false);
      assert.ok(Object.values(payload.data).every((value) => typeof value === 'string'));
      assert.equal(await repo.claimOne(), null);
    });
    await check('transient retries use persisted backoff and stop at max attempts', async () => {
      const fixture = await makeDelivery(); let calls = 0;
      const sender = worker(provider(async () => { calls++; throw { code: 'messaging/server-unavailable', message: fixture.device.fcmToken }; }));
      for (let attempt = 1; attempt <= 5; attempt++) {
        await sender.runOnce();
        const current = await row(fixture.delivery.id);
        assert.equal(current.attempts, attempt);
        assert.equal(current.claimVersion, BigInt(attempt));
        assert.equal(current.status, attempt === 5 ? 'FAILED' : 'PENDING');
        assert.equal(current.lastErrorCode, 'messaging/server-unavailable');
        assert.equal(current.leaseExpiresAt, null);
        if (attempt < 5) {
          assert.ok(current.nextAttemptAt > new Date());
          assert.equal((await sender.runOnce()).claimed, 0);
          await prisma.$executeRaw`UPDATE notification_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${current.id}`;
        }
      }
      assert.equal(calls, 5);
    });
    await check('permanent payload failure retains the valid device without retry', async () => {
      const fixture = await makeDelivery();
      await worker(provider(async () => { throw { code: 'messaging/invalid-argument' }; })).runOnce();
      assert.equal((await row(fixture.delivery.id)).status, 'FAILED');
      assert.equal((await row(fixture.delivery.id)).attempts, 1);
      assert.equal((await prisma.device.findUnique({ where: { id: fixture.device.id } })).deletedAt, null);
    });
    await check('invalid registration token soft deletes only its bound device and retains delivery history', async () => {
      const fixture = await makeDelivery();
      await worker(provider(async () => { throw { code: 'messaging/registration-token-not-registered' }; })).runOnce();
      const delivered = await row(fixture.delivery.id);
      assert.equal(delivered.status, 'FAILED');
      assert.ok(delivered.deletedAt);
      assert.ok((await prisma.device.findUnique({ where: { id: fixture.device.id } })).deletedAt);
      assert.equal(delivered.lastErrorCode, 'messaging/registration-token-not-registered');
    });
    await check('expired leases are reclaimed and stale acknowledgements cannot mutate the newer claim', async () => {
      const fixture = await makeDelivery();
      const first = await repo.claimOne();
      await expireClaim(first.id);
      const second = await repo.claimOne();
      assert.equal(second.claimVersion, 2n);
      assert.equal(await repo.sent(first, 'stale-provider-id'), false);
      assert.equal(await repo.failed(first, { code: 'messaging/invalid-registration-token', permanent: true, invalidDevice: true, delaySeconds: 0 }), false);
      assert.equal((await prisma.device.findUnique({ where: { id: fixture.device.id } })).deletedAt, null);
      assert.equal(await repo.sent(second, 'new-provider-id'), true);
      assert.equal((await row(fixture.delivery.id)).providerMessageId, 'new-provider-id');
    });
    await check('an exhausted abandoned claim becomes FAILED without another send', async () => {
      const fixture = await makeDelivery();
      await prisma.$executeRaw`UPDATE notification_deliveries SET max_attempts=1 WHERE id=${fixture.delivery.id}`;
      const claim = await repo.claimOne(); await expireClaim(claim.id);
      let calls = 0;
      await worker(provider(async () => { calls++; return 'unexpected'; })).runOnce();
      assert.equal(calls, 0);
      assert.equal((await row(fixture.delivery.id)).status, 'FAILED');
      assert.equal((await row(fixture.delivery.id)).lastErrorCode, 'LEASE_EXPIRED');
    });
    await check('device reassignment before an attempt cancels old ownership work', async () => {
      const fixture = await makeDelivery(), claim = await repo.claimOne(), next = await customer();
      await prisma.device.update({ where: { id: fixture.device.id }, data: { userId: next.id } });
      assert.equal(await repo.prepareAttempt(claim), null);
      assert.equal(await repo.sent(claim, 'stale'), false);
      assert.equal((await row(fixture.delivery.id)).status, 'CANCELLED');
    });
    await check('late invalid-token response cannot delete a reassigned device', async () => {
      const fixture = await makeDelivery(), next = await customer();
      await worker(provider(async () => {
        await prisma.device.update({ where: { id: fixture.device.id }, data: { userId: next.id } });
        throw { code: 'messaging/invalid-registration-token' };
      })).runOnce();
      const device = await prisma.device.findUnique({ where: { id: fixture.device.id } });
      assert.equal(device.userId, next.id);
      assert.equal(device.deletedAt, null);
      assert.equal((await row(fixture.delivery.id)).status, 'CANCELLED');
    });
    await check('opt-out and notification deletion invalidate claims before delivery', async () => {
      const fixture = await makeDelivery(), claim = await repo.claimOne();
      await prisma.userSettings.update({ where: { userId: fixture.user.id }, data: { notificationsEnabled: false } });
      assert.equal(await repo.prepareAttempt(claim), null);
      assert.equal((await row(fixture.delivery.id)).status, 'CANCELLED');
      const deleted = await makeDelivery(), second = await repo.claimOne();
      await prisma.notification.update({ where: { id: deleted.notification.id }, data: { deletedAt: new Date() } });
      assert.equal(await repo.prepareAttempt(second), null);
      assert.ok((await row(deleted.delivery.id)).deletedAt);
    });
    await check('suspending an account with devices retains devices and retires delivery claims', async () => {
      const fixture = await makeDelivery(), claim = await repo.claimOne();
      await prisma.user.update({ where: { id: fixture.user.id }, data: { accountStatus: 'SUSPENDED', suspensionReason: 'Fixture suspension' } });
      assert.ok((await prisma.device.findUnique({ where: { id: fixture.device.id } })).deletedAt);
      assert.ok((await row(fixture.delivery.id)).deletedAt);
      assert.equal(await repo.prepareAttempt(claim), null);
      await prisma.user.update({ where: { id: fixture.user.id }, data: { accountStatus: 'ACTIVE' } });
      assert.equal(await repo.claimOne(), null);
    });
    await check('appointment expiry is checked again before push after inbox materialization', async () => {
      const fixture = await makeReminder();
      await reminderRepository.materialize(fixture.candidate);
      const claim = await repo.claimOne();
      await pastAppointment(fixture.request.id);
      assert.equal(await repo.prepareAttempt(claim), null);
      assert.equal((await row(claim.id)).status, 'CANCELLED');
    });
    await check('a current reminder uses its request target and bounded appointment TTL', async () => {
      const fixture = await makeReminder();
      await reminderRepository.materialize(fixture.candidate);
      let payload;
      await worker(provider(async (value) => { payload = value; return 'reminder-id'; })).runOnce();
      assert.equal(payload.data.requestId, String(fixture.request.id));
      assert.equal(payload.data.reminderId, String(fixture.candidate.id));
      assert.ok(payload.android.ttl > 0 && payload.android.ttl <= 600000);
    });
    await check('provider readiness failure leaves queued work unclaimed', async () => {
      const fixture = await makeDelivery();
      await assert.rejects(worker({ ready: async () => { throw { code: 'app/invalid-credential' }; }, send: async () => 'unused' }).runOnce());
      assert.equal((await row(fixture.delivery.id)).status, 'PENDING');
      assert.equal((await row(fixture.delivery.id)).attempts, 0);
    });
    await check('provider timeout retries and ignores a late provider result', async () => {
      const fixture = await makeDelivery(), late = deferred();
      await worker(provider(() => late.promise), { timeoutMs: 10 }).runOnce();
      late.resolve('too-late'); await immediate();
      assert.equal((await row(fixture.delivery.id)).status, 'PENDING');
      assert.equal((await row(fixture.delivery.id)).lastErrorCode, 'PUSH_TIMEOUT');
    });
    await check('acknowledgement failure preserves the lease for recovery instead of misclassifying provider success', async () => {
      const fixture = await makeDelivery(); let calls = 0;
      const adapter = provider(async () => `accepted-${++calls}`);
      await assert.rejects(worker(adapter, { repository: { ...repo, sent: async () => { throw { code: 'DB_UNAVAILABLE' }; } } }).runOnce());
      assert.equal((await row(fixture.delivery.id)).status, 'PROCESSING');
      assert.equal((await row(fixture.delivery.id)).lastErrorCode, null);
      await expireClaim(fixture.delivery.id);
      await worker(adapter).runOnce();
      assert.equal(calls, 2);
      assert.equal((await row(fixture.delivery.id)).status, 'SENT');
      assert.equal((await row(fixture.delivery.id)).attempts, 2);
    });
    await check('unknown provider messages never leak raw token/payload into error codes', async () => {
      const fixture = await makeDelivery();
      await worker(provider(async () => { throw { code: `bad token ${fixture.device.fcmToken}`, message: 'sensitive provider payload' }; })).runOnce();
      assert.equal((await row(fixture.delivery.id)).lastErrorCode, 'PUSH_PROVIDER_ERROR');
    });
    await check('recurring jobs stop new runs and drain their active promise', async () => {
      const gate = deferred(); let calls = 0, observedStop = false;
      const stop = startRecurringJob({ name: 'fixture', intervalMs: 1, run: async ({ shouldStop }) => {
        calls++; await gate.promise; observedStop = shouldStop();
      } });
      await delay(10);
      let drained = false;
      const stopping = stop().then(() => { drained = true; });
      await immediate(); assert.equal(drained, false); assert.equal(calls, 1);
      gate.resolve(); await stopping; await delay(5);
      assert.equal(observedStop, true); assert.equal(calls, 1);
      const disabled = startPushJob({ enabled: false, worker: { runOnce: async () => { throw new Error('Must not start'); } } });
      await disabled();
    });
    await check('lane failure waits for other active sends before ending the cycle', async () => {
      const sending = deferred(), fail = deferred(), entered = deferred(); let claimIndex = 0, sent = 0;
      const repository = { claimOne: async () => ({ id: ++claimIndex, attempts: 1 }),
        prepareAttempt: async (claim) => { if (claim.id === 1) { await fail.promise; throw new Error('Database unavailable'); }
          return { id: 1, type: 'NEW_MESSAGE', title: 'Title', body: 'Body', deviceToken: 'token' }; },
        sent: async () => { sent++; return true; } };
      let finished = false;
      const running = worker(provider(async () => { entered.resolve(); return sending.promise; }), { repository, concurrency: 2, limit: 2 })
        .runOnce().finally(() => { finished = true; });
      const rejected = assert.rejects(running);
      await entered.promise; fail.resolve(); await immediate(); assert.equal(finished, false);
      sending.resolve('accepted'); await rejected; assert.equal(sent, 1);
    });
    console.log(`Validated isolated database: ${database}`);
  } finally { await prisma.$disconnect(); }
});
