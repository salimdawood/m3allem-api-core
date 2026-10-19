import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { seedArtifactTarget } from './seed-target.js';

const target = seedArtifactTarget();
const manifest = JSON.parse(await readFile(resolve(target.root, 'manifest.json'), 'utf8'));
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.APP_ENV, 'staging');
assert.equal(process.env.PUSH_DELIVERY_ENABLED, 'false');
assert.equal(process.env.OTP_FIXED_CODE, '111111');
assert.equal(manifest.database, target.database);
assert.equal(manifest.branchId, target.branchId);
assert.equal(manifest.host, target.host);
assert.equal(database.pathname, `/${target.database}`);
assert.equal(database.hostname.replace('-pooler.', '.'), manifest.host);
// Start the actual HTTP app on a free loopback port; recurring jobs are tested separately.
process.env.LOG_LEVEL = 'silent';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/database.js');
const { closeRedis } = await import('../src/config/redis.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [], sessions = [];
async function request(path, { method = 'GET', body, token, status = 200 } = {}) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function check(name, fn) { await fn(); results.push(name); console.log(`PASS ${name}`); }
try {
  await check('Liveness and database readiness', async () => {
    assert.equal((await request('/health/live')).status, 'live');
    assert.equal((await request('/health/ready')).status, 'ready');
  });
  await check('Localized catalog', async () => {
    for (const language of ['en', 'fr', 'ar']) {
      const response = await fetch(base + '/v1/catalog', { headers: { 'Accept-Language': language }, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.categories.length, 6);
      assert.equal(data.workerTypes.length, 14);
    }
  });
  const actors = {};
  for (const name of ['customer', 'worker', 'admin']) await check(`${name} OTP login and authenticated identity`, async () => {
    const account = manifest.accounts[name];
    const challenge = await request('/v1/auth/otp/send', { method: 'POST', body: { phoneNumber: account.phoneNumber } });
    const login = await request('/v1/auth/otp/verify', { method: 'POST', body: {
      phoneNumber: account.phoneNumber, challengeId: challenge.challengeId, code: '111111' } });
    assert.equal(login.status, 'EXISTING_USER');
    const actor = { token: login.tokens.accessToken, refresh: login.tokens.refreshToken };
    sessions.push(actor); actors[name] = actor;
    assert.equal((await request('/v1/auth/me', { token: actor.token })).id, account.id);
    assert.equal(login.user.isAdmin, name === 'admin');
    if (name === 'worker') assert.equal(login.user.isWorker, true);
  });
  await check('Worker discovery and seeded public worker', async () => {
    const list = await request('/v1/workers?limit=5', { token: actors.customer.token });
    assert.ok(list.items.length > 0);
    assert.equal((await request(`/v1/workers/${manifest.accounts.worker.workerId}`, { token: actors.customer.token })).id, manifest.accounts.worker.workerId);
    assert.equal((await request('/v1/me/worker', { token: actors.worker.token })).id, manifest.accounts.worker.workerId);
  });
  await check('Seeded request and conversation reads', async () => {
    for (const path of ['/v1/service-requests?as=worker&limit=5', '/v1/conversations?limit=5']) {
      const data = await request(path, { token: actors.worker.token });
      assert.ok(data.items.length > 0, `Expected seeded records for ${path}`);
    }
  });
  await check('Admin scope and private document download', async () => {
    await request('/v1/admin/verifications', { token: actors.customer.token, status: 403 });
    const pending = await request('/v1/admin/verifications?limit=1', { token: actors.admin.token });
    assert.ok(pending.items.length > 0);
    const document = await request(`/v1/admin/verifications/${pending.items[0].id}/document`, { token: actors.admin.token });
    const url = new URL(document.url);
    assert.equal(url.hostname, `${manifest.branchId}.storage.c-7.us-east-2.aws.neon.tech`);
    const asset = manifest.assets.find(a => url.pathname === `/${a.bucket}/${a.key}`);
    assert.ok(asset, 'Signed document must refer to an inventoried fixture');
    const response = await fetch(document.url, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), asset.sha256);
  });
  await check('Refresh rotation, logout and session rejection', async () => {
    const actor = actors.customer;
    const rotated = await request('/v1/auth/refresh', { method: 'POST', body: { refreshToken: actor.refresh } });
    actor.token = rotated.accessToken;
    actor.refresh = rotated.refreshToken;
    await request('/v1/auth/me', { token: actor.token });
    await request('/v1/auth/logout', { method: 'POST', token: actor.token, body: {}, status: 204 });
    actor.loggedOut = true;
    await request('/v1/auth/me', { token: actor.token, status: 401 });
  });
} finally {
  for (const actor of sessions) if (!actor.loggedOut) await request('/v1/auth/logout', { method: 'POST', token: actor.token, body: {}, status: 204 });
  await new Promise(resolve => server.close(resolve));
  await closeRedis();
  await prisma.$disconnect();
  await writeFile(resolve(target.root, 'api-smoke-result.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
    database: manifest.database, checks: results, successful: results.length === 9 }, null, 2) + '\n');
}
