import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { operations, schemas, inputSchema, ref } from './api-contract.js';

const json = (value) => JSON.stringify(value, null, 2);
const root = new URL('../', import.meta.url);
const responseSchema = (value) => typeof value === 'string' ? ref(value) : value;
const input = (op) => op.validator ? inputSchema(op.validator) : { properties: {} };
const content = (schema) => ({ 'application/json': { schema } });
export function buildOpenApi() {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'M3allem API', version: '2.0.0', description: 'Numeric IDs and universal soft deletion. Generated from scripts/api-contract.js and current route validators. SQL owns domain rules. Breaking changes from the original UUID contract; see API.md for lifecycle rules, timestamp differences, realtime and client migration.' },
    servers: [{ url: 'http://localhost:3001/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [...new Set(operations.map((op) => op.tag))].map((name) => ({ name })),
    paths: {},
    components: { securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '15-minute access JWT backed by a current live account/session.' },
      registrationBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Single-use five-minute registration JWT from NEW_USER login. Only /auth/register accepts it.' }
    }, schemas, responses: { Error: { description: 'Request failed. HTTP status and error.code identify the outcome.', content: content(ref('Error')) } } }
  };
  for (const op of operations) {
    const envelope = input(op), parameters = [];
    for (const [location, part] of [['path', 'params'], ['query', 'query']]) {
      const section = envelope.properties?.[part];
      for (const [name, schema] of Object.entries(section?.properties ?? {})) parameters.push({ name, in: location,
        required: location === 'path' || (section.required ?? []).includes(name), schema });
    }
    if (op.catalog) parameters.push({ name: 'Accept-Language', in: 'header', schema: { type: 'string', example: 'ar-LB,fr;q=0.8,en;q=0.5' } });
    if (op.captureCatalog) parameters.push({ name: 'If-None-Match', in: 'header', schema: { type: 'string' } });
    const responses = {};
    for (const status of [op.status, ...(op.extraStatuses ?? [])]) responses[status] = status === 204 || status === 304
      ? { description: status === 204 ? 'Success; no body.' : 'Not modified; no body.' }
      : { description: status === 503 ? 'Readiness unavailable.' : 'Success.', content: content(status === 503 ? ref('Unavailable') : responseSchema(op.response)) };
    for (const status of [400, 401, 403, 404, 409, 413, 415, 429, 500, 503, 504]) if (!responses[status]) responses[status] = { $ref: '#/components/responses/Error' };
    if (op.captureCatalog) for (const status of [200, 304]) responses[status].headers = {
      ETag: { schema: { type: 'string' } }, Vary: { schema: { type: 'string', const: 'Accept-Language' } }, 'Cache-Control': { schema: { type: 'string' } }
    };
    const entry = { operationId: op.operationId, tags: [op.tag], summary: op.summary,
      description: [op.description, op.actor === 'admin' ? 'Requires current active isAdmin authority.' : '', op.destructive ? 'Changes or retires retained resources; choose this operation deliberately.' : ''].filter(Boolean).join(' '),
      security: op.auth === 'public' ? [] : [{ [op.auth === 'registration' ? 'registrationBearer' : 'bearerAuth']: [] }],
      ...(parameters.length ? { parameters } : {}), responses };
    if (op.root) entry.servers = [{ url: 'http://localhost:3001' }];
    const body = envelope.properties?.body;
    if (op.multipart) entry.requestBody = { required: true, content: { 'multipart/form-data': { schema: {
      type: 'object', required: ['file'], additionalProperties: false, properties: { file: { type: 'string', format: 'binary' } }
    } } } };
    else if (body && (Object.keys(body.properties ?? {}).length || body.oneOf || body.anyOf)) entry.requestBody = {
      required: (envelope.required ?? []).includes('body'), content: content(body)
    };
    (spec.paths[op.path] ??= {})[op.method] = entry;
  }
  return spec;
}

// JSON-quoted scalars keep regexes, colons and Unicode unambiguous in YAML 1.2.
function yaml(value, depth = 0) {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) return value.length ? value.map((v) => isContainer(v)
    ? `${indent}-\n${yaml(v, depth + 1)}` : `${indent}- ${JSON.stringify(v)}`).join('\n') : `${indent}[]`;
  if (value && typeof value === 'object') return Object.keys(value).length ? Object.entries(value).map(([key, v]) => isContainer(v)
    ? `${indent}${JSON.stringify(key)}:\n${yaml(v, depth + 1)}` : `${indent}${JSON.stringify(key)}: ${JSON.stringify(v)}`).join('\n') : `${indent}{}`;
  return `${indent}${JSON.stringify(value)}`;
}
const isContainer = (v) => v && typeof v === 'object' && Object.keys(v).length > 0;

const numericVariables = new Set(['categoryId', 'workerTypeId', 'workerId', 'workerUserId', 'customerId', 'documentId', 'identityUploadId', 'profileImageUploadId',
  'adminId', 'conversationId', 'messageId', 'serviceRequestId', 'requestVersion', 'reviewId', 'notificationId', 'scheduledAt', 'customerChallengeId', 'workerChallengeId', 'adminChallengeId', 'newChallengeId', 'phoneChallengeId', 'emailChallengeId']);

// Illustrative DTOs only: never load account credentials or captured responses.
function exampleValue(schema, field = '') {
  if (schema.$ref) return exampleValue(schemas[schema.$ref.split('/').at(-1)], field);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf || schema.anyOf) return exampleValue((schema.oneOf ?? schema.anyOf).find(s => s.type !== 'null'), field);
  if (schema.type === 'null') return null;
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).filter(([key]) => (schema.required ?? []).includes(key)).map(([key, value]) => [key, exampleValue(value, key)]));
  if (schema.type === 'array') return [exampleValue(schema.items, field)];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.description === 'Unix epoch milliseconds.') return 1893456000000;
    return schema.minimum ?? 1;
  }
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2030-01-01T00:00:00.000Z';
    const samples = { accessToken: 'example-access-token-do-not-use', refreshToken: 'example-refresh-token-do-not-use',
      registrationToken: 'example-registration-token-do-not-use', fullName: 'Example account', workerName: 'Example worker',
      userName: 'Example customer', customerName: 'Example customer', phoneNumber: '+96170100001', publicPhoneNumber: '+96170100002',
      whatsappNumber: '+96170100002', destination: '+96170100001', developerCode: '111111', recoveryEmail: 'customer@example.test',
      nationality: 'LB', currency: 'USD', opensAt: '09:00', closesAt: '17:00', timeZone: 'Asia/Beirut',
      url: 'https://example.invalid/example', legalUrl: 'https://example.invalid/privacy', imageUrl: 'https://example.invalid/image.jpg',
      version: '1.0.0', minSupportedVersion: '1.0.0', contentType: 'image/jpeg', failureCode: null, nextCursor: null,
      text: 'Hello, I would like to discuss a service.', comment: 'Thank you for the service.', details: 'Example service request' };
    return Object.hasOwn(samples, field) ? samples[field] : 'example';
  }
  return {};
}
function postmanResponses(op, request) {
  const statuses = [op.status, ...(op.extraStatuses ?? [])];
  return statuses.flatMap(code => {
    const schema = code === 503 ? ref('Unavailable') : op.response ? responseSchema(op.response) : null;
    const resolved = schema?.$ref ? schemas[schema.$ref.split('/').at(-1)] : schema;
    const variants = resolved?.oneOf ?? [schema];
    return variants.map((variant, index) => {
      const sample = variant ? exampleValue(variant) : null;
      if (op.response === 'Upload') {
        sample.status = 'READY';
        sample.failureCode = null;
        if (op.path.endsWith('/identity-document')) {
          sample.purpose = 'IDENTITY_DOCUMENT'; sample.contentType = 'application/pdf';
        }
        if (op.path.endsWith('/profile-image') || (op.method === 'get' && op.path === '/uploads/{id}'))
          sample.url = 'https://example.invalid/example.jpg';
      }
      if (op.response === 'Worker' || op.response === 'WorkerPage') {
        for (const worker of op.response === 'WorkerPage' ? sample.items : [sample]) {
          worker.verificationStatus = 'VERIFIED';
          worker.isListed = true;
          if (!op.path.startsWith('/me/') && op.method === 'get') worker.isFavorite = false;
        }
      }
      return {
      name: `${code} — illustrative response${variants.length > 1 ? ` (alternative ${index + 1})` : ''}`,
      originalRequest: request, status: ({ 200: 'OK', 201: 'Created', 204: 'No Content', 304: 'Not Modified', 503: 'Service Unavailable' })[code], code,
      _postman_previewlanguage: 'json', header: [204, 304].includes(code) ? [] : [{ key: 'Content-Type', value: 'application/json' }],
      body: [204, 304].includes(code) ? '' : json(sample)
    }; });
  });
}
function postmanRequest(op, overrides = {}) {
  op = { ...op, ...overrides };
  const actor = op.actor ?? 'customer';
  const bearer = op.auth === 'registration' ? '{{registrationToken}}' : `{{${actor}AccessToken}}`;
  const path = op.path.replace(/\{(\w+)\}/g, (_match, key) => `{{${op.pathVars?.[key] ?? key}}}`);
  const query = new URLSearchParams(op.queryExample ?? {}).toString();
  const req = { method: op.method.toUpperCase(), header: [], url: `${op.root ? '{{rootUrl}}' : '{{baseUrl}}'}${path}${query ? `?${query}` : ''}`,
    description: `${op.description ?? op.summary}\nResponses: ${[op.status, ...(op.extraStatuses ?? [])].join('/')}. ${op.destructive ? 'Run deliberately; changes retained resources.' : ''}`,
    auth: op.auth === 'public' ? { type: 'noauth' } : { type: 'bearer', bearer: [{ key: 'token', value: bearer, type: 'string' }] } };
  if (op.catalog) req.header.push({ key: 'Accept-Language', value: 'en' });
  let raw;
  if (op.multipart) req.body = { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: [] }] };
  else if (op.example !== undefined) {
    raw = json(op.example).replace(/"\{\{(\w+)\}\}"/g, (match, key) => numericVariables.has(key) ? `{{${key}}}` : match);
    req.header.push({ key: 'Content-Type', value: 'application/json' });
    req.body = { mode: 'raw', raw, options: { raw: { language: 'json' } } };
  }
  const prerequest = [];
  if (raw?.includes('{{scheduledAt}}')) prerequest.push("savedVariables.set('scheduledAt', Date.now() + 86400000);");
  const numericUsed = [...new Set(`${raw ?? ''} ${req.url}`.match(/\{\{\w+\}\}/g) ?? [])].map((v) => v.slice(2, -2)).filter((v) => numericVariables.has(v));
  for (const name of numericUsed) prerequest.push(`{ const value = Number(pm.variables.get('${name}')); if (!Number.isSafeInteger(value) || value < 1) throw new Error('Set ${name} from a successful response before running this request.'); }`);
  const success = [op.status, ...(op.extraStatuses ?? []).filter((s) => s < 400)];
  const tests = ["const savedVariables = pm.environment?.has('rootUrl') ? pm.environment : pm.collectionVariables;", `pm.test('Expected status', () => pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(success)}));`,
    'if (pm.response.code >= 200 && pm.response.code < 300 && pm.response.code !== 204) {', '  const data = pm.response.json();'];
  for (const [variable, field] of Object.entries(op.capture ?? {})) tests.push(`  if (data.${field} != null) savedVariables.set('${variable}', data.${field});`);
  for (const [variable, field] of Object.entries(op.captureFirst ?? {})) tests.push(`  if (data[0]?.${field} != null) savedVariables.set('${variable}', data[0].${field});`);
  if (op.captureCatalog) tests.push("  const category = data.categories.find(c => data.workerTypes.some(t => t.categoryId === c.id));",
    "  if (category) { savedVariables.set('categoryId', category.id); savedVariables.set('workerTypeId', data.workerTypes.find(t => t.categoryId === category.id).id); }");
  if (op.tokenFlow) tests.push('  const tokens = data.tokens ?? (data.accessToken ? data : null);',
    `  if (tokens) { savedVariables.set('${op.tokenFlow}AccessToken', tokens.accessToken); savedVariables.set('${op.tokenFlow}RefreshToken', tokens.refreshToken); }`,
    `  if (data.status === 'NEW_USER') { savedVariables.unset('${op.tokenFlow}AccessToken'); savedVariables.unset('${op.tokenFlow}RefreshToken'); }`,
    "  if (data.registrationToken) savedVariables.set('registrationToken', data.registrationToken);",
    `  if (data.user) savedVariables.set('${op.tokenFlow === 'worker' ? 'workerUserId' : `${op.tokenFlow}Id`}', data.user.id);`);
  tests.push('}');
  if (op.path === '/auth/logout') tests.push(`if (pm.response.code === 204) { savedVariables.unset('${actor}AccessToken'); savedVariables.unset('${actor}RefreshToken'); }`);
  return { name: op.name ?? op.summary, request: req, response: postmanResponses(op, req), event: [
    ...(prerequest.length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["const savedVariables = pm.environment?.has('rootUrl') ? pm.environment : pm.collectionVariables;", ...prerequest] } }] : []),
    { listen: 'test', script: { type: 'text/javascript', exec: tests } }
  ] };
}
export function buildPostman() {
  const find = (method, path) => operations.find((op) => op.method === method && op.path === path);
  const logins = ['customer', 'worker', 'admin'].map((actor) => ({ name: `Authenticate ${actor} account`, item: [
    postmanRequest(find('post', '/auth/otp/send'), { name: 'Send login OTP', example: { phoneNumber: `{{${actor}Phone}}` }, capture: { [`${actor}ChallengeId`]: 'challengeId' } }),
    postmanRequest(find('post', '/auth/otp/verify'), { name: 'Verify and save account tokens', tokenFlow: actor,
      example: { phoneNumber: `{{${actor}Phone}}`, challengeId: `{{${actor}ChallengeId}}`, code: '{{otpCode}}' } })
  ] }));
  const sessions = { name: 'Sessions — refresh or logout the selected account', item: ['customer', 'worker', 'admin'].map(actor => ({
    name: `${actor} session`, item: [
      postmanRequest(find('post', '/auth/refresh'), { name: `Refresh ${actor} tokens`, actor, tokenFlow: actor, example: { refreshToken: `{{${actor}RefreshToken}}` } }),
      postmanRequest(find('post', '/auth/logout'), { name: `Logout ${actor}`, actor })
    ]
  })) };
  const onboarding = { name: 'Register a fresh account (choose customer or worker token destination)', item: [
    postmanRequest(find('post', '/auth/otp/send'), { example: { phoneNumber: '{{newUserPhone}}' }, capture: { newChallengeId: 'challengeId' } }),
    postmanRequest(find('post', '/auth/otp/verify'), { example: { phoneNumber: '{{newUserPhone}}', challengeId: '{{newChallengeId}}', code: '{{otpCode}}' } }),
    postmanRequest(find('post', '/auth/register')),
    postmanRequest(find('post', '/auth/register'), { name: 'Alternative: register as future worker account', tokenFlow: 'worker', example: { fullName: 'New worker', nationality: 'LB' } })
  ] };
  const folders = [...new Set(operations.map((op) => op.tag))].map((tag) => ({ name: tag, item: operations.filter((op) => op.tag === tag && !op.destructive).map((op) => postmanRequest(op)) }));
  const journey = { name: 'Request completion journey (requires verified worker + both logins)', item: [
    postmanRequest(find('post', '/service-requests')),
    postmanRequest(find('patch', '/service-requests/{id}')),
    postmanRequest(find('patch', '/service-requests/{id}'), { name: 'Worker completes accepted request', example: { status: 'COMPLETED', version: '{{requestVersion}}' } }),
    postmanRequest(find('post', '/workers/{id}/reviews')),
    postmanRequest(find('get', '/service-requests/{id}/events'))
  ] };
  const variables = {
    rootUrl: 'http://localhost:3001', baseUrl: '{{rootUrl}}/v1', otpCode: '111111',
    customerPhone: '+96170000001', workerPhone: '+96170000002', adminPhone: '+96170000003', newUserPhone: '+96170999999',
    newPhoneNumber: '+96170999998', recoveryEmail: 'customer@example.test', fcmToken: 'replace-with-real-android-registration-token',
    registrationToken: '', customerAccessToken: '', customerRefreshToken: '', workerAccessToken: '', workerRefreshToken: '', adminAccessToken: '', adminRefreshToken: '',
    ...Object.fromEntries([...numericVariables].map((name) => [name, '']))
  };
  return {
    info: { _postman_id: 'f6cb861d-82c1-4ef5-a7f5-e459da7bc261', name: 'M3allem API',
      description: 'Android/backend handoff: all 84 implemented HTTP operations, illustrative response examples, separate customer/worker/admin logins and sessions. Current single Neon branch is production, but the API uses staging/mock settings with OTP 111111. Default phones match the synthetic seed. Run Account setup logins, Catalog, then Workers > Read own live worker profile to capture workerId. The collection creates no seeds or admin grants. Set rootUrl to the API server (never a Neon database/storage URL); baseUrl derives from rootUrl. Use folders selectively, not Run all. Examples are synthetic documentation, never usable tokens or captured live responses. See postman/README.md for Android URLs, types and ordered journeys.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: Object.entries(variables).map(([key, value]) => ({ key, value, type: 'string' })),
    item: [{ name: 'Account setup', item: [...logins, onboarding] }, sessions, journey, ...folders,
      { name: 'Lifecycle and security changes (run deliberately)', item: operations.filter((op) => op.destructive).map((op) => postmanRequest(op)) }]
  };
}

function describe(schema) {
  if (schema.$ref) return `[${schema.$ref.split('/').at(-1)}](#schema-${schema.$ref.split('/').at(-1).toLowerCase()})`;
  if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf).map(describe).join(' or ');
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (schema.enum) return schema.enum.map((v) => `\`${v}\``).join(', ');
  if (schema.type === 'array') return `array of ${describe(schema.items)}`;
  const rules = [];
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'format', 'pattern', 'default'])
    if (schema[key] !== undefined) rules.push(`${key}: ${JSON.stringify(schema[key]).replaceAll('|', '\\|')}`);
  return `${schema.type ?? 'any'}${rules.length ? ` (${rules.join('; ')})` : ''}`;
}
function fields(schema, prefix = '') {
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).filter((branch) => branch.properties || branch.anyOf || branch.oneOf)
    .map((branch, i) => [`| ${prefix || 'body'} alternative ${i + 1} | | ${describe(branch)} |`, ...fields(branch, prefix)]).flat();
  return Object.entries(schema.properties ?? {}).flatMap(([name, child]) => {
    const key = `${prefix}${name}`;
    return [`| \`${key}\` | ${(schema.required ?? []).includes(name) ? 'yes' : 'no'} | ${describe(child)} |`,
      ...fields(child, `${key}.`), ...(child.type === 'array' ? fields(child.items, `${key}[].`) : [])];
  });
}
const guide = `# M3allem API (numeric-ID contract)

Generated by \`npm run docs:generate\` from [api-contract.js](../scripts/api-contract.js) and current request validators. [schema.sql](../database/schema.sql) owns database rules; routes/services define implemented HTTP behavior. [OpenAPI](../openapi.yaml) and [Postman](../postman/README.md) describe the same operations. This replaces the original UUID/role contract.

## Conventions and authentication

- Current local base: \`http://localhost:3001/v1\`. Configure actual staging/production hosts; no deployed host is assumed. Production requires HTTPS.
- JSON is camelCase with direct objects/arrays, without a universal data wrapper. 204/304 have no body. Multipart uploads use one \`file\` field.
- Entity IDs, relationship IDs, message numbers and versions are positive JSON integers through 9007199254740991. JSON strings/UUIDs are rejected. URL path/query values are decimal text. Catalog IDs are numeric; slugs are separate display/lookup fields.
- Most DTO timestamps are epoch milliseconds. **Inbox notification readAt/createdAt and contact-history createdAt are ISO 8601 strings**, as are health timestamps. Realtime notification timestamps currently serialize as ISO strings and their fields depend on the producer; use events to refetch the inbox. Do not assume a universal timestamp representation.
- Access bearer tokens last 15 minutes and identify a current account/session. HTTP and realtime authorization recheck database state. Registration uses a separate five-minute, single-use bearer token only for \`POST /auth/register\`. Refresh returns a bare token pair; save rotated pairs together. Refresh reuse revokes the family. Logout requires access authentication and optionally an FCM token.
- Login, phone change and recovery-email confirmation require the exact returned challengeId. Account recovery uses email/code against the latest recovery challenge and exposes neither challengeId nor developerCode. OTP codes are six-character strings, preserving leading zeros. Failed attempts and reuse revocations remain committed.
- Phone input normalizes Lebanese national/international forms to +961 plus 7–8 digits. Email trims/lowercases. Staging uses its configured fixed OTP and returns developerCode for ordinary challenges; production sends real SMS/email codes.
- Accounts can hire and own one worker profile. isWorker is capability; isAdmin is independently provisioned through trusted operations. Public requests cannot grant admin access or choose an exclusive role.
- Catalog/banner language is selected from weighted Accept-Language (en/fr/ar), with English fallback. Settings language is stored separately; this API does not promise localized notification text.
- Request bodies reject unknown fields on validated routes. Body-specific and cross-field limits are listed below. JSON limit is 1 MiB; uploads have separate limits. API rate limit is 300 requests per five minutes plus configured OTP IP/destination limits. Rate-limit responses use 429.

## Errors

Errors use \`{error:{code,message,details?},requestId}\`. Treat code/status as machine fields. Typical statuses: 400 invalid input/domain rule; 401 unavailable authentication/session; 403 forbidden actor; 404 missing/hidden resource; 409 uniqueness/version/lifecycle conflict; 413 too large; 415 unsupported media; 429 rate limited; 500/503/504 server unavailable/failure/timeout. Readiness 503 is a documented exception to the envelope. Validation details are not guaranteed.

## Lifecycle and pagination

All resources retain tombstones; DELETE means soft deletion. There is no general purge or universal restore API. Account deletion is terminal and reserves identifiers. Suspension retires sessions/devices and is reversible only through trusted admin moderation; reactivation requires fresh login/device registration. Object bytes remain after upload tombstones, and issued URLs can remain usable until expiry.

Worker restore requires the full editable body and fresh identity verification. Include existing numeric child IDs to retain/restore services and shifts; omitted children are tombstoned. Type-array order defines primary type; category remains fixed. Discounts, other users' favorites and old verification are not restored automatically.

Only original participants read chat/request history; admins have no chat-content bypass. A conversation starter controls the shared thread lifecycle. Restore leaves messages tombstoned until their authors restore them. Request customer deletes/restores terminal requests; original events/history restore, reviews restore separately. Source restoration does not replay reminders or notifications.

Requests fix participants/details/appointment at creation. Worker transitions: PENDING → ACCEPTED or DECLINED; ACCEPTED → COMPLETED. Customer transitions: PENDING or ACCEPTED → CANCELLED. Every transition needs the last read version; stale versions return 409. Reason is allowed only for decline/cancellation. There is no rescheduling endpoint. Reviews require an original customer and completed request; proof remains immutable. SQL updates aggregates on edits/tombstones/restores.

Conversation/request/review/search collections return \`{items,nextCursor}\` with account/filter-bound opaque keyset cursors, default limit 50 and maximum 200. Reuse returned cursors unchanged; values can change while scrolling, so pages are not snapshots. Messages use exclusive beforeNumber and return the newest matching page in ascending sequence order with nextBeforeNumber. Upload/verification pages use afterId/nextAfterId. Request events use afterVersion/nextAfterVersion. Null ends a page sequence. Nearby/favorite expansion and notifications/history are bounded bare arrays, as documented per route.

## Complete client journeys

1. Send login OTP → verify exact challenge. EXISTING_USER saves user/tokens; NEW_USER saves registrationToken, registers name/optional nationality/location, then saves tokens. Create the account before any upload. Upload avatar → PATCH /me with profileImageUploadId.
2. As a separate future worker account, get catalog → create worker using current category/type IDs → upload private identity document → submit uploadId → a different active admin obtains a scoped review link and approves current submission. Verify /me/worker and public discovery. Public detail remains hidden until listed, verified and enabled by catalog.
3. Customer creates/reuses conversation → sends text → peer reads messages using sequence pagination. Use HTTP for writes; reconnect realtime with a fresh access token and refetch missed data.
4. Customer creates request → worker reads and accepts with version → worker completes using returned version → original customer posts a review with that requestId. Cancellation and decline are alternative branches, not additional steps after completion.
5. Customer accepts device notifications by registering a real FCM token and enabling settings. An accepted future appointment creates SQL reminders for both eligible participants. Reminder job creates inbox entries; SQL queues push. Validate inbox reads and mark-read independently of handset delivery.
6. Exercise deletion/restoration deliberately on dedicated local fixtures. Do not run all Postman requests as one scenario: approval/rejection, registration alternatives, moderation and deletion branches conflict by design. No user/admin fixture is seeded by the normal bootstrap. Actual application client source is not present in this workspace; client payload changes must be applied in that repository.

## Realtime and push

Connect \`ws://localhost:3001/v1/realtime\` (wss in production) with an Authorization bearer **header**. A query-string token does not authenticate. Server sends \`{event,data}\`, starting with connected/userId. Client messages close with 1008; auth expiry/revocation closes with 4401. Session state is rechecked before publishes and periodically every 15 seconds. No replay/ack protocol is implemented; refetch HTTP state after reconnect.

Events: connected, favorites.updated, worker.updated, worker.deleted, conversation.updated, conversation.deleted, message.created, message.deleted, message.restored, request.created, request.updated, request.deleted, request.restored, notification.created. Message lifecycle events identify id/conversationId. Other lifecycle events identify id. Worker updates may be a full worker or a partial ID/verification update; refetch /me/worker or current public detail as appropriate.

Push uses Firebase data messages with string fields notificationId/type/title/body and applicable requestId/conversationId/workerId/reminderId. Reminders include scheduledAt as epoch-millisecond text. These transport strings do not change numeric HTTP IDs. Push is at least once; deduplicate by notificationId. SENT records Firebase acceptance, not confirmed handset receipt. Timeout or acknowledgement failure can duplicate delivery. Reminder Android TTL is bounded by appointment time and one hour. Opt-outs, retired devices and ineligible appointments are rechecked before sending, but an external send already in progress cannot be recalled.

PUSH_DELIVERY_ENABLED=false leaves delivery work queued and unclaimed. If absent, enabled only in production; .env.example explicitly disables it. Local validation substitutes providers; real Firebase/SMS/email/storage operations and client integration still require separate validation.

## Endpoint reference

All paths below are relative to /v1 except /health/live and /health/ready, which use the server root. Authorization defaults to an access bearer. Body/query/path fields are structural rules from validators; operation descriptions include domain/cross-field rules. Response definitions follow the endpoint list.
`;
export function buildMarkdown() {
  const sections = [guide];
  for (const tag of [...new Set(operations.map((op) => op.tag))]) {
    sections.push(`## ${tag}\n`);
    for (const op of operations.filter((item) => item.tag === tag)) {
      sections.push(`### ${op.method.toUpperCase()} ${op.root ? '(root) ' : ''}${op.path}\n`,
        `${op.summary}. Authorization: **${op.auth}${op.actor === 'admin' ? ' (current admin)' : ''}**.\n`,
        `${op.description ?? ''}\n`, `Responses: **${[op.status, ...(op.extraStatuses ?? [])].join(', ')}**. Response: ${op.response ? describe(responseSchema(op.response)) : 'no body'}.\n`);
      const envelope = input(op);
      for (const part of ['params', 'query', 'body']) {
        const rows = fields(envelope.properties?.[part] ?? {});
        if (rows.length) sections.push(`**${part}**\n`, '| Field | Required | Type and limits |\n| --- | --- | --- |', ...rows, '');
      }
      if (op.multipart) sections.push('Multipart body: one required binary `file` field; select a local file in Postman.\n');
    }
  }
  sections.push('## Response schemas\n', 'Required fields and nullable values are explicit below. HTTP response schemas use OpenAPI 3.1 JSON Schema syntax. Optional fields vary by endpoint as described above.\n');
  for (const [name, schema] of Object.entries(schemas)) sections.push(`<a id="schema-${name.toLowerCase()}"></a>\n\n### ${name}\n\n\`\`\`json\n${json(schema)}\n\`\`\`\n`);
  return sections.join('\n');
}

export function buildPostmanEnvironments() {
  return [
    ['M3allem_Local.postman_environment.json', 'f0570d15-714b-46f0-adc2-7f8ea12393eb', 'M3allem Local', 'http://localhost:3001'],
    ['M3allem_API_Server.postman_environment.json', '37d09aa9-3bc8-493a-920f-27ce3e6f2573', 'M3allem Render Test API', 'https://m3allem-api-core.onrender.com']
  ].map(([filename, id, name, rootUrl]) => ({ filename, environment: {
    id, name, values: [
      { key: 'rootUrl', value: rootUrl, enabled: true }, { key: 'baseUrl', value: '{{rootUrl}}/v1', enabled: true }
    ], _postman_variable_scope: 'environment'
  } }));
}

export async function generate() {
  await mkdir(new URL('postman/', root), { recursive: true });
  await writeFile(new URL('openapi.yaml', root), `# Generated by npm run docs:generate; edit scripts/api-contract.js or the route validators.\n${yaml(buildOpenApi())}\n`);
  await writeFile(new URL('docs/API.md', root), buildMarkdown());
  await writeFile(new URL('postman/M3allem_API.postman_collection.json', root), `${json(buildPostman())}\n`);
  for (const { filename, environment } of buildPostmanEnvironments())
    await writeFile(new URL(`postman/${filename}`, root), `${json(environment)}\n`);
  process.stdout.write(`Generated API.md, OpenAPI and Postman for ${operations.length} HTTP operations.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await generate();
