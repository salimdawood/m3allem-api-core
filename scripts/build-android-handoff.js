// Explicit developer handoff: live staging login/refresh + read-only API checks.
// Writes private test tokens only to the ignored handoff directory, never stdout.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { buildPostman, buildPostmanEnvironments } from './generate-api-docs.js';
import { schemas, operations } from './api-contract.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://m3allem-api-core.onrender.com';
const branchId = 'br-plain-glade-b50xod5j';
const storageEndpoint = `https://${branchId}.storage.c-7.us-east-2.aws.neon.tech`;
const publicProfileBase = `${storageEndpoint}/seed-public-profiles`;
const wsUrl = `${origin.replace('https:', 'wss:')}/v1/realtime`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, 'handoff', `M3allem_Android_Handoff_${stamp}`);
const seed = JSON.parse(await readFile(resolve(root, '.seed-data/production/manifest.json'), 'utf8'));
assert.equal(seed.branchId, branchId);
const results = [], actors = {}, variables = new Map([['rootUrl', origin], ['baseUrl', '{{rootUrl}}/v1'], ['otpCode', '111111']]);
const generatedAt = new Date().toISOString();
async function save(path, value) {
  const dest = resolve(output, path);
  assert.ok(dest.startsWith(output + sep), 'Output must stay inside handoff directory');
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
}
async function api(path, { actor, body } = {}) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
    headers: { 'accept-language': 'en', ...(body ? { 'content-type': 'application/json' } : {}), ...(actor ? { authorization: `Bearer ${actors[actor].accessToken}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`HTTP ${response.status} ${path}: ${data.error?.code ?? 'REQUEST_FAILED'}`);
  }
  return response.json();
}
async function check(name, run, required = true) {
  try { const value = await run(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); return value; }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); if (required) throw error; console.log(`UNVERIFIED ${name}: ${error.message}`); return null; }
}
await check('Deployed process and database readiness', async () => {
  assert.equal((await api('/health/live')).status, 'live');
  assert.equal((await api('/health/ready')).status, 'ready');
  assert.equal((await api('/v1/health')).env, 'staging', 'Only the staging API may issue fixed-code handoff tokens');
});
const catalog = await check('Public catalog', async () => {
  const data = await api('/v1/catalog'); assert.equal(data.categories.length, 6); assert.equal(data.workerTypes.length, 14); return data;
});
for (const actor of ['customer', 'worker', 'admin']) {
  await check(`${actor} staging login, refresh rotation and current identity`, async () => {
    const account = seed.accounts[actor];
    const challenge = await api('/v1/auth/otp/send', { body: { phoneNumber: account.phoneNumber } });
    const login = await api('/v1/auth/otp/verify', { body: { phoneNumber: account.phoneNumber, challengeId: challenge.challengeId, code: '111111' } });
    assert.equal(login.status, 'EXISTING_USER'); assert.equal(login.user.id, account.id);
    actors[actor] = await api('/v1/auth/refresh', { body: { refreshToken: login.tokens.refreshToken } });
    const identity = await api('/v1/auth/me', { actor }); assert.equal(identity.id, account.id);
    if (actor === 'admin') assert.equal(identity.isAdmin, true);
    if (actor === 'worker') assert.equal(identity.isWorker, true);
    for (const [key, value] of Object.entries({ [`${actor}Phone`]: account.phoneNumber, [`${actor}AccessToken`]: actors[actor].accessToken,
      [`${actor}RefreshToken`]: actors[actor].refreshToken, [actor === 'worker' ? 'workerUserId' : `${actor}Id`]: account.id,
      [`${actor}ChallengeId`]: challenge.challengeId })) variables.set(key, value);
  });
}
const worker = await check('Owned worker and public worker detail/search', async () => {
  const own = await api('/v1/me/worker', { actor: 'worker' });
  assert.equal(own.id, seed.accounts.worker.workerId);
  const publicWorker = await api(`/v1/workers/${own.id}`, { actor: 'customer' });
  const search = await api('/v1/workers?limit=5', { actor: 'customer' }); assert.ok(search.items.length);
  variables.set('workerId', own.id); variables.set('categoryId', own.categoryId); variables.set('workerTypeId', own.workerTypeIds[0]);
  return publicWorker;
});
await check('Seeded customer conversation/request reads and notification inbox', async () => {
  const conversations = await api('/v1/conversations?limit=200', { actor: 'customer' });
  const conversation = conversations.items.find(item => item.workerId === worker.id);
  if (conversation) {
    variables.set('conversationId', conversation.id);
    const messages = await api(`/v1/conversations/${conversation.id}/messages?limit=1`, { actor: 'customer' });
    if (messages.items.length) variables.set('messageId', messages.items[0].id);
  }
  const requests = await api('/v1/service-requests?as=customer&limit=200', { actor: 'customer' });
  const request = requests.items.find(item => item.workerId === worker.id);
  if (request) { variables.set('serviceRequestId', request.id); variables.set('requestVersion', request.version); }
  const inbox = await api('/v1/notifications', { actor: 'customer' });
  if (inbox.length) variables.set('notificationId', inbox[0].id);
});
await check('Admin pending queue and signed Neon private PDF download', async () => {
  const pending = await api('/v1/admin/verifications?limit=1', { actor: 'admin' }); assert.ok(pending.items.length);
  const document = pending.items[0]; variables.set('documentId', document.id);
  const signed = await api(`/v1/admin/verifications/${document.id}/document`, { actor: 'admin' });
  const url = new URL(signed.url); assert.equal(url.origin, storageEndpoint); assert.equal(signed.expiresIn, 300);
  const asset = seed.assets.find(item => url.pathname === `/${item.bucket}/${item.key}`); assert.ok(asset);
  const response = await fetch(signed.url, { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), asset.sha256);
}, false);
await check('Authenticated Render WebSocket upgrade and connected event', () => new Promise((done, reject) => {
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${actors.customer.accessToken}` }, handshakeTimeout: 15000 });
  let finished = false;
  const timer = setTimeout(() => finish(new Error('WebSocket connected event timed out')), 15000);
  function finish(error) { if (finished) return; finished = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : done(); }
  socket.on('message', raw => { try { const data = JSON.parse(raw.toString()); assert.equal(data.event, 'connected'); assert.equal(data.data.userId, seed.accounts.customer.id); finish(); } catch (error) { finish(error); } });
  socket.on('error', error => finish(error));
  socket.on('close', () => { if (!finished) finish(new Error('WebSocket closed before connected event')); });
}), false);

const substitutes = { API_ORIGIN: origin, WS_URL: wsUrl, STORAGE_ENDPOINT: storageEndpoint, PUBLIC_PROFILE_BASE: publicProfileBase };
const template = text => text.replace(/\{\{(API_ORIGIN|WS_URL|STORAGE_ENDPOINT|PUBLIC_PROFILE_BASE)\}\}/g, (_match, key) => substitutes[key]);
for (const [source, dest] of [
  ['README.md', 'README.md'], ['AGENT_GUIDE.md', 'AGENTS.md'], ['ANDROID_INTEGRATION.md', 'docs/ANDROID_INTEGRATION.md'],
  ['FILES_AND_STORAGE.md', 'docs/FILES_AND_STORAGE.md'], ['TEST_JOURNEYS.md', 'docs/TEST_JOURNEYS.md'],
  ['SCHEMA_GUIDE.md', 'database/SCHEMA_GUIDE.md'], ['Snippets.kt', 'examples/Snippets.kt']
]) await save(dest, template(await readFile(resolve(root, 'docs/android', source), 'utf8')));
await save('database/schema.sql', await readFile(resolve(root, 'database/schema.sql')));
await save('database/schema.prisma', await readFile(resolve(root, 'prisma/schema.prisma')));
await save('docs/API.md', (await readFile(resolve(root, 'docs/API.md'), 'utf8')).replace('[api-contract.js](../scripts/api-contract.js)', '`scripts/api-contract.js`').replace('(../openapi.yaml)', '(../api/openapi.yaml)').replaceAll('http://localhost:3001', origin));
await save('api/openapi.yaml', (await readFile(resolve(root, 'openapi.yaml'), 'utf8')).replaceAll('http://localhost:3001', origin));
await save('api/response-schemas.json', { $schema: 'https://json-schema.org/draft/2020-12/schema', components: { schemas } });
await save('postman/README.md', (await readFile(resolve(root, 'postman/README.md'), 'utf8')).replace('[api-contract.js](../scripts/api-contract.js)', '`scripts/api-contract.js`'));
const collection = buildPostman(); collection.info.name = 'M3allem API — Android Render Handoff';
collection.variable.find(value => value.key === 'rootUrl').value = origin;
await save('postman/M3allem_API.postman_collection.json', collection);
const shared = buildPostmanEnvironments().find(value => value.filename === 'M3allem_API_Server.postman_environment.json');
await save(`postman/${shared.filename}`, shared.environment);
await save('postman/M3allem_Render_Authenticated.private.postman_environment.json', { id: randomUUID(), name: 'M3allem Render — authenticated QA (private)',
  values: [...variables].map(([key, value]) => ({ key, value, enabled: true, type: /Token$/.test(key) ? 'secret' : 'default' })), _postman_variable_scope: 'environment' });
const fixture = seed.assets[0], fixtureBytes = await readFile(resolve(root, '.seed-data/production', fixture.path));
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), fixture.sha256);
await save('examples/synthetic-identity.pdf', fixtureBytes);
await save('examples/sample-avatar.png', await sharp({ create: { width: 128, height: 128, channels: 3, background: '#397d92' } }).png().toBuffer());
await save('examples/catalog.en.json', catalog); await save('examples/public-worker.json', worker);
const tokenExpiries = Object.fromEntries(Object.entries(actors).map(([actor, tokens]) => [actor,
  new Date(JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString()).exp * 1000).toISOString()]));
const schema = await readFile(resolve(root, 'database/schema.sql'), 'utf8');
const tables = [...schema.matchAll(/^CREATE TABLE (\w+)\s*\(/gm)].map(match => match[1]); assert.equal(tables.length, 29);
await save('environment.json', { generatedAt, apiOrigin: origin, apiBaseUrl: `${origin}/v1`, retrofitBaseUrl: `${origin}/v1/`, realtimeUrl: wsUrl,
  appEnvironment: 'staging', project: 'M3allem', neonBranch: 'production', database: 'neondb', postgresMajorVersion: 18, tableNames: tables,
  accounts: seed.accounts, accessTokenExpiresAt: tokenExpiries,
  storage: { endpoint: storageEndpoint, profileBucket: 'seed-public-profiles', publicProfileBaseUrl: publicProfileBase,
    identityBucket: 'seed-private-identities', identityAccess: 'API-issued signed URL, 300 seconds', publicProfileObjectsAtInspection: 0 },
  httpOperations: operations.length, notes: ['Credentials exist only in the private Postman environment.', 'Branch name production does not change deployed staging OTP behavior.'] });
await save('verification.json', { generatedAt, completedAt: new Date().toISOString(), target: origin, checks: results,
  notPerformed: ['New avatar or identity object writes', 'Profile modifications', 'New messages, service requests or reviews', 'Identity decisions', 'Real SMS/email/FCM delivery', 'Android app execution'],
  writesPerformed: ['Staging OTP challenges', 'New login sessions and one refresh rotation per actor; exported sessions remain active'],
  baseline: { nodeTests: 109, sqlSchemaTests: 51, lastLocalResult: 'passed', liveSchemaVerified: 'users.id is bigint; schema.sql is the authoritative source, not a live database dump' } });
const files = [];
async function inventory(dir) { for (const item of await readdir(dir, { withFileTypes: true })) {
  const file = join(dir, item.name); if (item.isDirectory()) await inventory(file); else {
    const bytes = await readFile(file); files.push({ path: relative(output, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
} }
await inventory(output); await save('MANIFEST.json', { generatedAt, privateTestCredentialsIncluded: true, files });
await mkdir(resolve(root, 'handoff'), { recursive: true });
await writeFile(resolve(root, 'handoff/latest-bundle-path.txt'), output);
console.log(`Created ${relative(root, output)} with ${files.length + 1} files. No credentials printed.`);
console.log('Package this directory as a private ZIP; exported test sessions remain active.');
