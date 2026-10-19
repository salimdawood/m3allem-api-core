import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(source, overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_ENV: 'test', APP_ENV: 'development', DELIVERY_MODE: 'mock',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'provider-test-access-secret-32-characters',
      OTP_HMAC_SECRET: 'provider-test-otp-secret-32-characters', OTP_FIXED_CODE: '111111',
      FCM_SERVICE_ACCOUNT_JSON: '', FCM_PROJECT_ID: '', OTP_EMAIL_FROM: '',
      LOG_LEVEL: 'info', ...overrides }
  });
}

test('mock SMS, email and default push worker operate without provider credentials or leaking payloads', () => {
  const result = run(`
    import assert from 'node:assert/strict';
    import { otpDelivery } from './src/modules/auth/otp-delivery.js';
    import { createNotificationWorker } from './src/modules/notifications/notification.service.js';
    import { prisma } from './src/config/database.js';
    await otpDelivery.send('+96170000001', '654321');
    await otpDelivery.send('private-recipient@example.test', '654321');
    let pending = true, accepted;
    const repository = {
      async claimOne() { if (!pending) return null; pending = false; return { id: 1, attempts: 1 }; },
      async prepareAttempt() { return { id: 1, type: 'NEW_MESSAGE', title: 'private-title', body: 'private-body', deviceToken: 'private-device-token' }; },
      async sent(claim, id) { accepted = id; return true; },
      async failed() { throw Error('Mock delivery must succeed'); }
    };
    assert.deepEqual(await createNotificationWorker({ repository, concurrency: 1, limit: 1 }).runOnce(), { claimed: 1, sent: 1, failed: 0 });
    assert.match(accepted, /^mock:[0-9a-f-]+$/);
    await prisma.$disconnect();
    console.log('MOCK_CHECK_PASSED');
  `);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /MOCK_CHECK_PASSED/);
  assert.match(result.stdout, /Mock OTP delivery accepted/);
  assert.match(result.stdout, /Mock push delivery accepted/);
  for (const secret of ['+96170000001', 'private-recipient', '654321', 'private-title', 'private-body', 'private-device-token']) {
    assert.ok(!result.stdout.includes(secret), `Logs exposed ${secret}`);
  }
});

test('live mode selects the real adapters without a silent mock fallback', () => {
  const result = run(`
    import assert from 'node:assert/strict';
    import { otpDelivery, liveOtpDelivery } from './src/modules/auth/otp-delivery.js';
    import { pushProvider } from './src/modules/notifications/push.provider.js';
    import { firebaseProvider } from './src/modules/notifications/firebase.provider.js';
    assert.equal(otpDelivery, liveOtpDelivery);
    assert.equal(pushProvider, firebaseProvider);
  `, { DELIVERY_MODE: 'live' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('production refuses mock mode', () => {
  for (const overrides of [{ APP_ENV: 'production' }, { NODE_ENV: 'production' }]) {
    const result = run("await import('./src/config/env.js');", overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Mock delivery is forbidden in production/);
  }
});
