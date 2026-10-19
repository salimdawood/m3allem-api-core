// Static artifact checks only: no environment loading, DB, API or provider calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { operations, schemas } from './api-contract.js';
import { buildOpenApi, buildPostman, buildMarkdown, buildPostmanEnvironments } from './generate-api-docs.js';

const routes = [
  ['auth/auth.routes.js', '/v1/auth'], ['auth/auth.me.routes.js', '/v1'], ['account/account.routes.js', '/v1'],
  ['catalog/catalog.routes.js', '/v1/catalog'], ['workers/worker.routes.js', '/v1'], ['interactions/interactions.routes.js', '/v1'],
  ['uploads/upload.routes.js', '/v1/uploads'], ['verification/verification.routes.js', '/v1'], ['health/health.routes.js', '']
];
const implemented = new Set();
for (const [file, prefix] of routes) {
  const source = await readFile(new URL(`../src/modules/${file}`, import.meta.url), 'utf8');
  for (const match of source.matchAll(/\b(?:r|router)\.(get|post|put|patch|delete)\('([^']+)'/g)) {
    const path = `${prefix}${match[2] === '/' ? '' : match[2]}`.replace(/:(\w+)/g, '{$1}');
    implemented.add(`${match[1]} ${path}`);
  }
}
const documented = new Set(operations.map((op) => `${op.method} ${op.root ? '' : '/v1'}${op.path}`));
assert.deepEqual([...documented].sort(), [...implemented].sort(), 'Route inventory drift');
assert.equal(documented.size, operations.length, 'Duplicate operations');
const spec = buildOpenApi(), collection = buildPostman();
const operationIds = new Set();
function references(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    const resolved = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key], spec);
    assert.ok(resolved, `Unresolved reference ${value.$ref}`);
  }
  for (const entry of Object.values(value)) references(entry);
}
references(spec);
for (const op of operations) {
  assert.ok(!operationIds.has(op.operationId), 'Duplicate operation ID'); operationIds.add(op.operationId);
  const entry = spec.paths[op.path][op.method];
  const paths = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual((entry.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name).sort(), paths);
  if (op.auth === 'public') assert.deepEqual(entry.security, []);
  if (op.auth === 'registration') assert.deepEqual(entry.security, [{ registrationBearer: [] }]);
  if (op.actor === 'admin') assert.match(entry.description, /admin/i);
  if (op.example !== undefined) {
    const body = JSON.parse(JSON.stringify(op.example).replace(/\{\{(\w+)\}\}/g, (_m, key) => key.endsWith('Phone') ? '+96170100001'
      : key === 'otpCode' ? '111111' : key === 'fcmToken' ? 'synthetic-device-token' : key === 'recoveryEmail' ? 'local@example.test'
        : key.endsWith('RefreshToken') ? 'synthetic-refresh-token-at-least-20-characters' : key === 'newPhoneNumber' ? '+96170100004' : key === 'scheduledAt' ? '2000000000000' : '1'),
    (key, value) => typeof value === 'string' && /^(categoryId|workerId|uploadId|profileImageUploadId|challengeId|requestId|version|scheduledAt)$/.test(key) ? Number(value) : value);
    // Worker type IDs are nested in an array, where the JSON reviver key is an index.
    if (body.workerTypeIds) body.workerTypeIds = body.workerTypeIds.map(Number);
    const result = op.validator.safeParse({ body, query: {}, params: Object.fromEntries(paths.map((key) => [key, '1'])) });
    assert.ok(result.success, `${op.operationId}: invalid example ${JSON.stringify(result.error?.issues)}`);
  }
}
assert.equal(spec.paths['/workers'].get.parameters.find((p) => p.name === 'limit').schema.type, 'integer');
assert.equal(spec.paths['/auth/logout'].post.requestBody.required, true);
assert.deepEqual(schemas.IdentityDocument.properties.status.enum, ['PENDING', 'VERIFIED', 'REJECTED']);

const vars = new Map(collection.variable.map((v) => [v.key, v.value]));
for (const [key, value] of vars) if (/Token$/.test(key) && key !== 'fcmToken') assert.equal(value, '', `Do not export credentials in ${key}`);
for (const key of vars.keys()) if (/Id$|Version$/.test(key)) vars.set(key, 1);
for (const actor of ['customer', 'worker', 'admin']) {
  vars.set(`${actor}AccessToken`, `synthetic-${actor}-access-token`);
  vars.set(`${actor}RefreshToken`, `synthetic-${actor}-refresh-token-over-20`);
}
let requests = 0;
const covered = new Set();
function matches(value, schema) {
  if (schema.$ref) return matches(value, schemas[schema.$ref.split('/').at(-1)]);
  if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf).some(branch => matches(value, branch));
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (schema.required ?? []).every(key => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, v]) => schema.properties?.[key] ? matches(v, schema.properties[key]) : schema.additionalProperties !== false);
  if (schema.type === 'array') return Array.isArray(value) && value.every(v => matches(v, schema.items));
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type) return typeof value === schema.type;
  return true;
}
function walk(items) {
  for (const item of items) {
    if (item.item) { walk(item.item); continue; }
    requests++;
    for (const event of item.event ?? []) new Script(event.script.exec.join('\n'));
    const url = item.request.url;
    const path = url.replace(/^\{\{baseUrl\}\}/, '/v1').replace(/^\{\{rootUrl\}\}/, '').split('?')[0];
    assert.ok(path.startsWith('/'), 'Unexpected URL');
    const candidates = operations.filter((op) => op.method.toUpperCase() === item.request.method &&
      new RegExp(`^${(op.root ? '' : '/v1') + op.path.replace(/\{\w+\}/g, '\\{\\{\\w+\\}\\}')}$`).test(path));
    assert.equal(candidates.length, 1, `Postman route mismatch ${item.request.method} ${url}`);
    covered.add(candidates[0].operationId);
    assert.ok(item.response.length, `Missing response examples: ${item.name}`);
    for (const example of item.response) {
      if ([204, 304].includes(example.code)) assert.equal(example.body, '');
      else {
        const response = example.code === 503 ? schemas.Unavailable : candidates[0].response;
        assert.ok(matches(JSON.parse(example.body), typeof response === 'string' ? schemas[response] : response), `Invalid response example: ${item.name}`);
      }
    }
    const context = createContext({ pm: { collectionVariables: { set: (k, v) => vars.set(k, v) }, variables: { get: (k) => vars.get(k) } } });
    for (const event of item.event ?? []) if (event.listen === 'prerequest') new Script(event.script.exec.join('\n')).runInContext(context);
    if (item.request.body?.mode === 'raw') {
      const text = item.request.body.raw.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
        assert.ok(vars.has(key), `Unknown variable ${key}`); return vars.get(key);
      });
      const body = JSON.parse(text);
      const op = candidates[0], names = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const result = op.validator.safeParse({ body, query: {}, params: Object.fromEntries(names.map((key) => [key, '1'])) });
      assert.ok(result.success, `Postman body ${item.name}: ${JSON.stringify(result.error?.issues)}`);
    }
  }
}
walk(collection.item);
// Execute actor session scripts with synthetic responses to catch token cross-talk.
function runResponse(item, code, data, environment) {
  const context = createContext({ pm: {
    test: (_name, callback) => callback(), expect: value => ({ to: { be: { oneOf: allowed => assert.ok(allowed.includes(value)) } } }),
    response: { code, json: () => data }, collectionVariables: { set: (key, value) => vars.set(key, value), unset: key => vars.delete(key) },
    ...(environment ? { environment: { has: key => environment.has(key), set: (key, value) => environment.set(key, value), unset: key => environment.delete(key) } } : {})
  } });
  for (const event of item.event ?? []) if (event.listen === 'test') new Script(event.script.exec.join('\n')).runInContext(context);
}
const sessionFolder = collection.item.find(item => item.name.startsWith('Sessions'));
for (const actor of ['customer', 'worker', 'admin']) {
  const account = sessionFolder.item.find(item => item.name === `${actor} session`);
  const other = actor === 'customer' ? 'worker' : 'customer';
  const previous = vars.get(`${other}AccessToken`);
  runResponse(account.item[0], 200, { accessToken: `${actor}-rotated-access`, refreshToken: `${actor}-rotated-refresh` });
  assert.equal(vars.get(`${actor}AccessToken`), `${actor}-rotated-access`);
  assert.equal(vars.get(`${actor}RefreshToken`), `${actor}-rotated-refresh`);
  assert.equal(vars.get(`${other}AccessToken`), previous);
  runResponse(account.item[1], 204);
  assert.ok(!vars.has(`${actor}AccessToken`) && !vars.has(`${actor}RefreshToken`));
  assert.equal(vars.get(`${other}AccessToken`), previous);
}
const login = collection.item[0].item[0].item[1];
vars.set('customerAccessToken', 'old-account-token');
vars.set('customerRefreshToken', 'old-account-refresh');
runResponse(login, 200, { status: 'NEW_USER', registrationToken: 'synthetic-registration-proof' });
assert.ok(!vars.has('customerAccessToken') && !vars.has('customerRefreshToken'));
assert.equal(vars.get('registrationToken'), 'synthetic-registration-proof');
const privateEnvironment = new Map([['rootUrl', 'http://localhost:3001'], ['workerAccessToken', 'old-private-access'], ['workerRefreshToken', 'old-private-refresh']]);
const workerSession = sessionFolder.item.find(item => item.name === 'worker session');
runResponse(workerSession.item[0], 200, { accessToken: 'new-private-access', refreshToken: 'new-private-refresh' }, privateEnvironment);
assert.equal(privateEnvironment.get('workerAccessToken'), 'new-private-access');
assert.equal(privateEnvironment.get('workerRefreshToken'), 'new-private-refresh');
runResponse(workerSession.item[1], 204, undefined, privateEnvironment);
assert.ok(!privateEnvironment.has('workerAccessToken') && !privateEnvironment.has('workerRefreshToken'));
assert.equal(covered.size, operations.length, 'Missing Postman operations');
assert.equal(await readFile(new URL('../postman/M3allem_API.postman_collection.json', import.meta.url), 'utf8'), `${JSON.stringify(collection, null, 2)}\n`, 'Postman artifact drift');
assert.equal(await readFile(new URL('../docs/API.md', import.meta.url), 'utf8'), buildMarkdown(), 'Markdown artifact drift');
for (const { filename, environment } of buildPostmanEnvironments()) {
  assert.equal(await readFile(new URL(`../postman/${filename}`, import.meta.url), 'utf8'), `${JSON.stringify(environment, null, 2)}\n`, 'Postman environment drift');
  assert.deepEqual(environment.values.map(v => v.key), ['rootUrl', 'baseUrl'], 'Keep account IDs and tokens out of shared environments');
}
console.log(`Contract checks passed: ${implemented.size} routes, ${Object.keys(schemas).length} response schemas, ${requests} Postman requests. No network or database used.`);
