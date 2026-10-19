// Creates private Postman credentials through the ordinary local staging API.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.APP_ENV, 'staging', 'This helper requires staging mode.');
assert.equal(process.env.DELIVERY_MODE, 'mock', 'This helper requires mock delivery.');
assert.equal(process.env.OTP_FIXED_CODE, '111111', 'This helper requires staging OTP configuration.');
const rootUrl = `http://localhost:${process.env.PORT || 3000}`;
const manifest = JSON.parse(await readFile(new URL('../.seed-data/production/manifest.json', import.meta.url), 'utf8'));
const destination = new URL('../postman/M3allem_Local_Authenticated.private.postman_environment.json', import.meta.url);
const values = new Map([['rootUrl', rootUrl], ['baseUrl', '{{rootUrl}}/v1'], ['otpCode', '111111']]);
async function api(path, { body, token } = {}) {
  const response = await fetch(rootUrl + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`${path}: HTTP ${response.status} (${data.error?.code ?? 'REQUEST_FAILED'}). OTP resend may require waiting 30 seconds.`);
  }
  return response.json();
}
assert.equal((await api('/v1/health')).env, 'staging');
assert.equal((await api('/health/ready')).status, 'ready');
let workerToken;
for (const actor of ['customer', 'worker', 'admin']) {
  const account = manifest.accounts[actor];
  const challenge = await api('/v1/auth/otp/send', { body: { phoneNumber: account.phoneNumber } });
  const login = await api('/v1/auth/otp/verify', { body: { phoneNumber: account.phoneNumber, challengeId: challenge.challengeId, code: '111111' } });
  assert.equal(login.status, 'EXISTING_USER');
  const identity = await api('/v1/auth/me', { token: login.tokens.accessToken });
  assert.equal(identity.id, account.id);
  if (actor === 'admin') assert.equal(identity.isAdmin, true);
  if (actor === 'worker') { assert.equal(identity.isWorker, true); workerToken = login.tokens.accessToken; }
  values.set(`${actor}Phone`, account.phoneNumber);
  values.set(`${actor}AccessToken`, login.tokens.accessToken);
  values.set(`${actor}RefreshToken`, login.tokens.refreshToken);
  values.set(actor === 'worker' ? 'workerUserId' : `${actor}Id`, identity.id);
  values.set(`${actor}ChallengeId`, challenge.challengeId);
}
const worker = await api('/v1/me/worker', { token: workerToken });
values.set('workerId', worker.id);
values.set('categoryId', worker.categoryId);
values.set('workerTypeId', worker.workerTypeIds[0]);
await writeFile(destination, `${JSON.stringify({ id: randomUUID(), name: 'M3allem Local — authenticated (private)',
  values: [...values].map(([key, value]) => ({ key, value, enabled: true, type: /Token$/.test(key) ? 'secret' : 'default' })),
  _postman_variable_scope: 'environment' }, null, 2)}\n`);
console.log('Saved postman/M3allem_Local_Authenticated.private.postman_environment.json');
console.log('Verified customer, worker and admin access through /auth/me. No tokens printed.');
console.log(`API: ${rootUrl}. Access tokens last 15 minutes; use the matching Sessions refresh request afterward.`);
