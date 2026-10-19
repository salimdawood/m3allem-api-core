// Documentation inputs mirror the implemented route validators. SQL owns domain rules.
import { schemas as auth } from '../src/modules/auth/auth.validation.js';
import { accountSchemas as account } from '../src/modules/account/account.validation.js';
import { workerSchemas as worker } from '../src/modules/workers/worker.validation.js';
import { interactionSchemas as interaction } from '../src/modules/interactions/interactions.validation.js';
import { verificationSchemas as verification } from '../src/modules/verification/verification.validation.js';
import { uploadIdSchema, uploadListSchema } from '../src/modules/uploads/upload.validation.js';

export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const num = (extra = {}) => ({ type: 'number', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const bool = { type: 'boolean' };
const values = (...items) => str({ enum: items });
const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const id = ref('Id'), epoch = ref('EpochMilliseconds'), iso = str({ format: 'date-time' });
const page = (item, key = 'nextCursor', cursor = nullable(str())) => object({ items: array(ref(item)), [key]: cursor });
const statuses = values('PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED');
const units = values('PER_HOUR', 'PER_VISIT', 'PER_JOB', 'PER_SESSION', 'PER_DAY');
const nameImage = { fullName: str(), profileImageUploadId: nullable(id) };
export const schemas = {
  Id: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Positive numeric identity. JSON strings and UUIDs are rejected.' }),
  EpochMilliseconds: int({ description: 'Unix epoch milliseconds.' }),
  Error: object({ error: object({ code: str(), message: str(), details: {} }, ['code', 'message']), requestId: str() }),
  Tokens: object({ accessToken: str(), refreshToken: str(), expiresIn: int({ const: 900 }) }),
  Location: object({ latitude: num(), longitude: num(), address: nullable(str()) }),
  User: object({ id, phoneNumber: str(), ...nameImage, location: nullable(ref('Location')), isAdmin: bool, isWorker: bool,
    accountStatus: values('ACTIVE', 'SUSPENDED', 'DELETED'), createdAt: epoch, recoveryEmail: nullable(str()), nationality: nullable(str()) }),
  PublicUser: object({ id, ...nameImage }),
  Authenticated: object({ user: ref('User'), tokens: ref('Tokens') }),
  OtpChallenge: object({ destination: str(), codeLength: int({ const: 6 }), resendAfterSeconds: int({ const: 30 }), challengeId: id,
    developerCode: str({ description: 'Present only in staging.' }) }, ['destination', 'codeLength', 'resendAfterSeconds', 'challengeId']),
  RecoveryReceipt: object({ destination: str(), codeLength: int({ const: 6 }), resendAfterSeconds: int({ const: 30 }) }),
  LoginResult: { oneOf: [object({ status: str({ const: 'NEW_USER' }), phoneNumber: str(), registrationToken: str() }),
    object({ status: str({ const: 'EXISTING_USER' }), user: ref('User'), tokens: ref('Tokens') })] },
  Settings: object({ notificationsEnabled: bool, reminderLeadMinutes: int({ enum: [0, 5, 15, 30, 60, 120, 1440] }), language: values('en', 'fr', 'ar') }),
  Favorites: object({ workerIds: array(id) }),
  Notification: object({ id, type: values('SERVICE_REQUEST_RECEIVED', 'SERVICE_REQUEST_SENT', 'SERVICE_REQUEST_UPDATED', 'NEW_MESSAGE', 'NEW_REVIEW', 'VERIFICATION_UPDATE', 'APPOINTMENT_REMINDER'),
    title: str(), body: str(), requestId: nullable(id), conversationId: nullable(id), workerId: nullable(id), readAt: nullable(iso), createdAt: iso }),
  Contact: object({ id, workerId: id, workerName: str(), profileImageUploadId: nullable(id), interactionType: values('SERVICE_REQUEST', 'CHAT', 'CALL', 'WHATSAPP'),
    createdAt: iso, conversationId: nullable(id), requestId: nullable(id), requestStatus: nullable(statuses) }),
  Accepted: object({ accepted: { type: 'boolean', const: true } }),
  Category: object({ id, slug: str(), name: str(), description: nullable(str()), iconKey: nullable(str()), sortOrder: int() }),
  WorkerType: object({ id, categoryId: id, slug: str(), name: str(), localName: nullable(str()), iconKey: nullable(str()), keywords: array(str()), sortOrder: int() }),
  Catalog: object({ categories: array(ref('Category')), workerTypes: array(ref('WorkerType')) }),
  Banner: object({ id, title: str(), subtitle: nullable(str()), imageUrl: nullable(str()), iconKey: nullable(str()), categoryId: nullable(id), language: values('en', 'fr', 'ar') }),
  Price: object({ amount: num({ minimum: 0 }), currency: str({ pattern: '^[A-Z]{3}$' }), unit: units }),
  Shift: object({ id, isoWeekday: int({ minimum: 1, maximum: 7 }), opensAt: str(), closesAt: str(), endDayOffset: int({ enum: [0, 1] }) }),
  WorkingHours: object({ timeZone: str(), shifts: array(ref('Shift')) }),
  Service: object({ id, name: str(), description: nullable(str()), price: nullable(ref('Price')) }),
  Discount: object({ id, type: values('PERCENTAGE', 'FIXED_AMOUNT'), value: num(), currency: nullable(str()), unit: nullable(units), title: nullable(str()), expiresAt: nullable(epoch) }),
  Worker: object({ id, userId: id, ...nameImage, publicPhoneNumber: str(), whatsappNumber: nullable(str()), categoryId: id, description: str(), experienceYears: int(),
    workerTypeIds: array(id), services: array(ref('Service')), startingPrice: nullable(ref('Price')), effectiveStartingPrice: nullable(ref('Price')),
    discount: nullable(ref('Discount')), workingHours: ref('WorkingHours'), location: ref('Location'), rating: num(), ratingCount: int(),
    verificationStatus: values('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'), isAvailable: bool, isListed: bool, distanceKm: nullable(num()), joinedAt: epoch, isFavorite: bool },
  // isFavorite is added by public search/detail; owned profile responses omit it.
  ['id', 'userId', 'fullName', 'profileImageUploadId', 'publicPhoneNumber', 'whatsappNumber', 'categoryId', 'description', 'experienceYears', 'workerTypeIds', 'services', 'startingPrice', 'effectiveStartingPrice', 'discount', 'workingHours', 'location', 'rating', 'ratingCount', 'verificationStatus', 'isAvailable', 'isListed', 'distanceKm', 'joinedAt']),
  WorkerPage: page('Worker'),
  Conversation: object({ id, customerId: id, workerId: id, workerUserId: id, customerName: str(), workerName: str(), customerImageUploadId: nullable(id), workerImageUploadId: nullable(id),
    lastMessageId: nullable(id), lastMessage: nullable(str()), lastMessageAt: nullable(epoch), createdAt: epoch, updatedAt: epoch }),
  ConversationPage: page('Conversation'),
  Message: object({ id, conversationId: id, senderId: id, messageNumber: id, text: str(), sentAt: epoch }),
  MessagePage: page('Message', 'nextBeforeNumber', nullable(id)),
  Request: object({ id, customerId: id, workerId: id, workerUserId: id, customerName: str(), workerName: str(), details: nullable(str()), scheduledAt: nullable(epoch),
    status: statuses, version: id, statusChangedBy: id, statusReason: nullable(str()), statusChangedAt: epoch, createdAt: epoch, updatedAt: epoch }),
  RequestPage: page('Request'),
  RequestEvent: object({ id, requestId: id, version: id, fromStatus: nullable(statuses), toStatus: statuses, actorId: id, reason: nullable(str()), occurredAt: epoch }),
  RequestEventPage: page('RequestEvent', 'nextAfterVersion', nullable(id)),
  Review: object({ id, workerId: id, userId: id, requestId: id, userName: str(), workerName: str(), rating: int({ minimum: 1, maximum: 5 }), comment: nullable(str()), createdAt: epoch, updatedAt: epoch }),
  ReviewPage: page('Review'),
  Upload: object({ id, purpose: values('PROFILE_IMAGE', 'IDENTITY_DOCUMENT'), status: values('PENDING', 'READY', 'FAILED', 'DELETING', 'DELETED'), contentType: nullable(str()), sizeBytes: nullable(int()),
    createdAt: epoch, uploadedAt: nullable(epoch), failureCode: nullable(str()), url: nullable(str()), expiresIn: int({ const: 300 }) },
  ['id', 'purpose', 'status', 'contentType', 'sizeBytes', 'createdAt', 'uploadedAt', 'failureCode']),
  UploadPage: page('Upload', 'nextAfterId', nullable(id)),
  IdentityDocument: object({ id, workerId: id, uploadId: id, workerName: str(), submissionNumber: id, type: values('NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE'),
    status: values('PENDING', 'VERIFIED', 'REJECTED'), isCurrent: bool, submittedAt: epoch, reviewedAt: nullable(epoch), reviewedBy: nullable(id), rejectionReason: nullable(str()) },
  ['id', 'workerId', 'uploadId', 'submissionNumber', 'type', 'status', 'isCurrent', 'submittedAt', 'reviewedAt', 'reviewedBy', 'rejectionReason']),
  IdentityPage: page('IdentityDocument', 'nextAfterId', nullable(id)),
  SignedUrl: object({ url: str(), expiresIn: int({ const: 300 }) }),
  Health: object({ status: str({ const: 'ok' }), env: values('staging', 'production'), version: str() }),
  Liveness: object({ success: { type: 'boolean', const: true }, status: str({ const: 'live' }), timestamp: iso }),
  Readiness: object({ success: { type: 'boolean', const: true }, status: str({ const: 'ready' }), timestamp: iso }),
  Unavailable: object({ success: { type: 'boolean', const: false }, status: str({ const: 'unavailable' }) }),
  AppConfig: object({ minSupportedVersion: str(), legalUrl: str() })
};

// Convert structural Zod rules only. Cross-field/refinement rules are described per operation.
export function inputSchema(zod) {
  const d = zod._def;
  switch (d.typeName) {
    case 'ZodEffects': return inputSchema(d.schema);
    case 'ZodOptional': return inputSchema(d.innerType);
    case 'ZodDefault': return { ...inputSchema(d.innerType), default: d.defaultValue() };
    case 'ZodNullable': return nullable(inputSchema(d.innerType));
    case 'ZodLiteral': return { type: typeof d.value, const: d.value };
    case 'ZodEnum': return values(...d.values);
    case 'ZodUnion': return { anyOf: d.options.map(inputSchema) };
    case 'ZodDiscriminatedUnion': return { oneOf: d.options.map(inputSchema) };
    case 'ZodPipeline': {
      const incoming = inputSchema(d.in), outgoing = inputSchema(d.out);
      return ['number', 'integer'].includes(incoming.type) && ['number', 'integer'].includes(outgoing.type)
        ? { ...incoming, ...outgoing } : incoming;
    }
    case 'ZodBoolean': return bool;
    case 'ZodNumber': {
      const result = num();
      for (const c of d.checks) {
        if (c.kind === 'int') result.type = 'integer';
        if (c.kind === 'min') result[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
        if (c.kind === 'max') result[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
      }
      return result;
    }
    case 'ZodString': {
      const result = str();
      for (const c of d.checks) {
        if (c.kind === 'min') result.minLength = c.value;
        if (c.kind === 'max') result.maxLength = c.value;
        if (c.kind === 'regex') result.pattern = c.regex.source;
        if (c.kind === 'email') result.format = 'email';
      }
      return result;
    }
    case 'ZodArray': return array(inputSchema(d.type), { ...(d.minLength ? { minItems: d.minLength.value } : {}), ...(d.maxLength ? { maxItems: d.maxLength.value } : {}) });
    case 'ZodObject': {
      const shape = d.shape();
      return { ...object(Object.fromEntries(Object.entries(shape).map(([k, v]) => {
        const converted = inputSchema(v), parsed = v.safeParse(undefined);
        if (converted.default === undefined && parsed.success && parsed.data !== undefined && typeof parsed.data === (converted.type === 'integer' ? 'number' : converted.type))
          converted.default = parsed.data;
        return [k, converted];
      })),
        Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([k]) => k)), additionalProperties: d.unknownKeys === 'passthrough' };
    }
    default: throw new Error(`Unsupported documentation validator ${d.typeName}`);
  }
}

export const operations = [];
function add(tag, method, path, summary, response, options = {}) {
  const operationId = `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  operations.push({ tag, method, path, summary, response, operationId, status: 200, auth: 'access', ...options });
}
const request = (validator, example, extra = {}) => ({ validator, example, ...extra });
const publicOp = { auth: 'public' };
const workerDraft = {
  publicPhoneNumber: '{{workerPhone}}', whatsappNumber: null, categoryId: '{{categoryId}}', workerTypeIds: ['{{workerTypeId}}'],
  description: 'Electrical repair and maintenance', experienceYears: 3, services: [{ name: 'Inspection', price: null }],
  startingPrice: { amount: 50, currency: 'USD', unit: 'PER_JOB' },
  workingHours: { timeZone: 'Asia/Beirut', shifts: [{ isoWeekday: 1, opensAt: '09:00', closesAt: '17:00', endDayOffset: 0 }] },
  location: { latitude: 33.89, longitude: 35.5 }, isAvailable: true, isListed: true
};
const own = { actor: 'worker' };
const admin = { actor: 'admin' };

add('Authentication', 'post', '/auth/otp/send', 'Send login OTP', 'OtpChallenge', request(auth.phone, { phoneNumber: '{{customerPhone}}' }, {
  ...publicOp, capture: { customerChallengeId: 'challengeId' }, description: 'Lebanese phone normalization. Latest challenge only; resends retire earlier challenges. Staging returns developerCode; production sends SMS.' }));
add('Authentication', 'post', '/auth/otp/verify', 'Verify exact login challenge', 'LoginResult', request(auth.verify, { phoneNumber: '{{customerPhone}}', challengeId: '{{customerChallengeId}}', code: '{{otpCode}}' }, {
  ...publicOp, tokenFlow: 'customer', description: 'EXISTING_USER returns user/tokens; NEW_USER returns a five-minute registration token. Failed attempt counters persist.' }));
add('Authentication', 'post', '/auth/register', 'Create account with registration bearer token', 'Authenticated', request(auth.register, { fullName: 'New customer', nationality: 'LB' }, {
  auth: 'registration', status: 201, tokenFlow: 'customer', description: 'Use the registrationToken from NEW_USER as bearer. Single use. No role or avatar URL input. Upload an avatar after creating the account.' }));
add('Authentication', 'post', '/auth/refresh', 'Rotate refresh token', 'Tokens', request(auth.refresh, { refreshToken: '{{customerRefreshToken}}' }, {
  ...publicOp, tokenFlow: 'customer', description: 'Response is a bare token pair. Save both tokens atomically. Reuse revokes the entire session family and returns 401.' }));
add('Authentication', 'post', '/auth/logout', 'Revoke current session and optionally retire device', null, request(auth.logout, { fcmToken: '{{fcmToken}}' }, {
  status: 204, description: 'Access bearer is required. Body contains only optional fcmToken. No refresh token input.' }));
add('Authentication', 'get', '/auth/me', 'Current account (alias of /me)', 'User');
add('Authentication', 'post', '/auth/recovery/request', 'Request email account recovery', 'RecoveryReceipt', request(auth.recovery, { email: '{{recoveryEmail}}' }, {
  ...publicOp, description: 'Same receipt for known/unknown emails. No challengeId or developerCode, including in staging.' }));
add('Authentication', 'post', '/auth/recovery/verify', 'Verify latest recovery code and replace sessions', 'Authenticated', request(auth.recoveryVerify, { email: '{{recoveryEmail}}', code: '{{otpCode}}' }, {
  ...publicOp, tokenFlow: 'customer', description: 'Uses email/code without challengeId. Successful recovery revokes prior sessions.' }));

add('Account', 'get', '/me', 'Read private current account', 'User', { capture: { customerId: 'id' } });
add('Account', 'patch', '/me', 'Edit private account profile', 'User', request(account.profile, { fullName: 'Updated customer', profileImageUploadId: '{{profileImageUploadId}}' }, {
  description: 'At least one editable field. Avatar must be an owned READY avatar upload. Null removes avatar/location/nationality. Name/avatar are canonical for the worker profile.' }));
add('Account', 'delete', '/me', 'Permanently soft delete account', null, request(account.deleteAccount, undefined, {
  status: 204, destructive: true, description: 'Terminal account tombstone; phone/email remain reserved. Owned resources and authorization/work records are retired. No account restore endpoint.' }));
add('Account', 'get', '/users/{id}', 'Read active public user profile', 'PublicUser', request(account.publicUser, undefined, { pathVars: { id: 'workerUserId' } }));
add('Account', 'post', '/me/phone/request', 'Request login phone change', 'OtpChallenge', request(auth.newPhone, { newPhoneNumber: '{{newPhoneNumber}}' }, { capture: { phoneChallengeId: 'challengeId' } }));
add('Account', 'post', '/me/phone/confirm', 'Confirm exact phone change challenge', 'User', request(auth.confirmPhone, { newPhoneNumber: '{{newPhoneNumber}}', challengeId: '{{phoneChallengeId}}', code: '{{otpCode}}' }, {
  destructive: true, description: 'Revokes existing sessions; authenticate again. Public worker phone remains independent.' }));
add('Account', 'post', '/me/recovery-email/request', 'Request recovery email verification', 'OtpChallenge', request(auth.recovery, { email: '{{recoveryEmail}}' }, { capture: { emailChallengeId: 'challengeId' } }));
add('Account', 'post', '/me/recovery-email/confirm', 'Confirm exact recovery email challenge', 'User', request(auth.confirmEmail, { email: '{{recoveryEmail}}', challengeId: '{{emailChallengeId}}', code: '{{otpCode}}' }, {
  destructive: true, description: 'Revokes existing sessions; authenticate again.' }));
add('Account', 'get', '/me/settings', 'Read settings or defaults', 'Settings', { description: 'Defaults: notificationsEnabled=true, reminderLeadMinutes=60, language=en. Lead zero disables reminders.' });
add('Account', 'put', '/me/settings', 'Replace settings', null, request(account.settings, { notificationsEnabled: true, reminderLeadMinutes: 60, language: 'en' }, { status: 204 }));
add('Account', 'patch', '/admin/users/{id}/status', 'Suspend or reactivate another account', null, request(account.accountStatus, { status: 'SUSPENDED', reason: 'Moderation review' }, {
  ...admin, status: 204, destructive: true, pathVars: { id: 'customerId' }, description: 'Active admin required; self moderation forbidden. ACTIVE has no reason field. Reactivation does not restore old sessions, devices or admin grants.' }));

add('Favorites', 'get', '/me/favorites', 'Read retained live favorite worker IDs', 'Favorites');
add('Favorites', 'get', '/me/favorites/workers', 'Expand visible favorite workers', array(ref('Worker')), { description: 'Bare array, at most 200, ordered by rating. Uses public visibility.' });
add('Favorites', 'put', '/me/favorites/{workerId}', 'Add or restore favorite', null, request(account.workerParam, undefined, { status: 204 }));
add('Favorites', 'delete', '/me/favorites/{workerId}', 'Soft delete favorite', null, request(account.workerParam, undefined, { status: 204, destructive: true }));
add('Notifications', 'get', '/notifications', 'Read latest 200 live inbox notifications', array(ref('Notification')), { captureFirst: { notificationId: 'id' }, description: 'Bare array, newest first. Typed targets; readAt and createdAt are ISO timestamps. No offset/cursor input.' });
add('Notifications', 'post', '/notifications/read-all', 'Mark all live inbox notifications read', null, { status: 204 });
add('Notifications', 'post', '/notifications/{id}/read', 'Mark owned notification read', null, request(account.notificationParam, undefined, { status: 204, pathVars: { id: 'notificationId' } }));
add('Notifications', 'post', '/devices', 'Register or transfer active device token', null, request(account.device, { fcmToken: '{{fcmToken}}', platform: 'android', locale: 'en', appVersion: '1.0.0' }, {
  status: 204, description: 'Registers for caller; an existing active token can transfer owners. Deleted device tokens create new rows; queued old ownership deliveries are not reused.' }));
add('Notifications', 'delete', '/devices/{fcmToken}', 'Soft delete caller device binding', null, request(account.fcmParam, undefined, { status: 204, destructive: true, description: 'URL-encode the full FCM token as one path segment.' }));
add('Account', 'get', '/me/contact-history', 'Read latest 250 contact history entries', array(ref('Contact')), { description: 'Bare array, newest first. createdAt is ISO. Request/chat history is created by SQL; retained names can refer to departed workers.' });
add('Account', 'post', '/me/contact-history', 'Record call or WhatsApp interaction', 'Accepted', request(account.contact, { workerId: '{{workerId}}', interactionType: 'CALL' }, { status: 201, description: 'Only CALL/WHATSAPP accepted. No arbitrary referenceId.' }));

add('Catalog', 'get', '/catalog', 'Read localized enabled categories and worker types', 'Catalog', {
  ...publicOp, catalog: true, captureCatalog: true, extraStatuses: [304], description: 'Weighted Accept-Language: en/fr/ar with English fallback. ETag, Vary: Accept-Language and If-None-Match revalidation; 304 has no body.' });
add('Catalog', 'get', '/catalog/banners', 'Read currently visible localized banners', array(ref('Banner')), {
  ...publicOp, catalog: true, description: 'English fallback only if the selected locale has no visible banners. Enforces schedule and enabled category.' });

add('Workers', 'get', '/workers', 'Search current public workers', 'WorkerPage', request(worker.search, undefined, {
  queryExample: { sort: 'RATING', limit: 50 }, description: 'Requires active account, listed/verified worker and enabled catalog. Both coordinates required together; distance sort/radius needs coordinates. Currency and priceUnit required together, and required for PRICE sort. Boolean query values are true/false. Cursor is account/filter/sort bound; no offset pagination.' }));
add('Workers', 'get', '/workers/nearby', 'Read nearest visible workers', array(ref('Worker')), request(worker.nearby, undefined, { queryExample: { lat: 33.89, lng: 35.5, radiusKm: 10, limit: 50 } }));
add('Workers', 'get', '/workers/{id}', 'Read public worker detail', 'Worker', request(worker.id, undefined, { pathVars: { id: 'workerId' } }));
add('Workers', 'get', '/me/worker', 'Read own live worker profile regardless of listing/verification', 'Worker', { ...own, capture: { workerId: 'id', workerUserId: 'userId' } });
add('Workers', 'post', '/workers', 'Create caller worker profile', 'Worker', request(worker.draft, workerDraft, {
  ...own, status: 201, capture: { workerId: 'id', workerUserId: 'userId' }, description: 'Any active account can own one profile and still hire. First workerTypeIds entry is primary. Category fixed after creation. No copied name/avatar or automatic verification.' }));
add('Workers', 'put', '/workers/{id}', 'Replace own worker profile and selected children', 'Worker', request(worker.update, workerDraft, {
  ...own, pathVars: { id: 'workerId' }, description: 'Full editable body required. Include existing service/shift IDs to keep identity; omitted children are tombstoned. Without IDs new children are created. Named time zone, numeric ISO weekdays, split/overnight shifts; positive duration at most 24 hours and no overlaps. Money at most two decimals; null means quote required, zero free.' }));
add('Workers', 'post', '/workers/{id}/restore', 'Restore retained own worker profile', 'Worker', request(worker.update, workerDraft, {
  ...own, pathVars: { id: 'workerId' }, description: 'Full editable body. Restores selected child IDs only. No old discounts/favorites/verification restored; fresh identity submission and approval required for discovery.' }));
add('Workers', 'delete', '/workers/{id}', 'Soft delete own worker profile', null, request(worker.id, undefined, { ...own, status: 204, destructive: true, pathVars: { id: 'workerId' } }));
add('Workers', 'put', '/workers/{id}/discount', 'Replace own active starting-price discount', 'Worker', request(worker.discount, { type: 'PERCENTAGE', value: 10 }, {
  ...own, pathVars: { id: 'workerId' }, description: 'Positive starting price required. Percentage >0 and <=100. Fixed amount >0 and <=base with matching currency/unit. Optional expiry must be future epoch milliseconds.' }));
add('Workers', 'delete', '/workers/{id}/discount', 'Soft delete own discount', 'Worker', request(worker.id, undefined, { ...own, destructive: true, pathVars: { id: 'workerId' } }));
add('Workers', 'put', '/workers/{id}/availability', 'Set own availability', 'Worker', request(worker.availability, { isAvailable: true }, { ...own, pathVars: { id: 'workerId' } }));
add('Workers', 'put', '/workers/{id}/listing', 'Set own discovery listing', 'Worker', request(worker.listing, { isListed: true }, { ...own, pathVars: { id: 'workerId' } }));

for (const [suffix, summary, max, mime, capture] of [
  ['profile-image', 'Upload avatar image', 5, 'JPEG/PNG/WebP', 'profileImageUploadId'],
  ['identity-document', 'Upload private identity document', 10, 'JPEG/PNG/PDF', 'identityUploadId']
]) add('Uploads', 'post', `/uploads/${suffix}`, summary, 'Upload', { status: 201, actor: suffix === 'identity-document' ? 'worker' : 'customer', multipart: true,
  capture: { [capture]: 'id' }, description: `Exactly one multipart file field, no extra fields. Limit ${max} MiB; ${mime}. Image bytes sanitized/re-encoded; multi-page/animated images rejected. Metadata row is retained on failures. Avatar response includes url; identity response has no URL/storage key. Registration tokens cannot upload.` });
add('Uploads', 'get', '/uploads', 'List owned live upload metadata', 'UploadPage', request(uploadListSchema));
add('Uploads', 'get', '/uploads/{id}', 'Resolve authorized upload metadata and URL', 'Upload', request(uploadIdSchema, undefined, {
  pathVars: { id: 'profileImageUploadId' }, description: 'Owner access; others may resolve READY avatars attached to active accounts. Identity owner-only here, including admins. Signed identity URL expires in 300 seconds; unfinished url=null.' }));
add('Uploads', 'delete', '/uploads/{id}', 'Soft delete unreferenced owned upload', null, request(uploadIdSchema, undefined, { status: 204, destructive: true,
  pathVars: { id: 'profileImageUploadId' }, description: 'Live avatar/document reference blocks deletion. Object bytes and metadata remain; already issued URLs are not revoked.' }));
add('Uploads', 'post', '/uploads/{id}/restore', 'Restore retained owned ready upload', 'Upload', request(uploadIdSchema, undefined, { pathVars: { id: 'profileImageUploadId' }, description: 'Only ready uploads with retained bytes. No restore for failed/unfinished/physically removed objects.' }));
add('Verification', 'post', '/me/worker/identity-documents', 'Submit fresh identity verification document', 'IdentityDocument', request(verification.submit, { type: 'NATIONAL_ID', uploadId: '{{identityUploadId}}' }, {
  ...own, status: 201, capture: { documentId: 'id' }, description: 'Unused owned READY private identity upload. New immutable submission becomes current/PENDING and supersedes previous current approval.' }));
add('Verification', 'get', '/me/worker/identity-documents', 'Read own live submission history', 'IdentityPage', request(verification.history, undefined, own));
add('Verification', 'get', '/me/worker/identity-documents/current', 'Read own current live submission', 'IdentityDocument', request(verification.current, undefined, own));
add('Verification', 'delete', '/me/worker/identity-documents/{documentId}', 'Soft delete owned identity submission', null, request(verification.id, undefined, {
  ...own, status: 204, destructive: true, description: 'Deleting current document clears current verification; earlier approval is not reused. No submission restore route.' }));
add('Verification', 'get', '/admin/verifications', 'List current pending verification queue', 'IdentityPage', request(verification.pending, undefined, { ...admin, queryExample: { status: 'PENDING', limit: 50 }, description: 'Active admin required. Only PENDING supported; completed/superseded submissions excluded.' }));
add('Verification', 'get', '/admin/verifications/{documentId}/document', 'Issue scoped review document link', 'SignedUrl', request(verification.id, undefined, { ...admin, description: 'Current pending non-self submission only. URL expires in 300 seconds.' }));
add('Verification', 'post', '/admin/verifications/{documentId}/approve', 'Approve current pending non-self submission', null, request(verification.id, undefined, { ...admin, status: 204, description: 'Review outcome immutable; actor rechecked inside transaction. Queues typed notification.' }));
add('Verification', 'post', '/admin/verifications/{documentId}/reject', 'Reject current pending non-self submission', null, request(verification.reject, { reason: 'Document is unreadable' }, { ...admin, status: 204 }));

add('Chat', 'get', '/conversations', 'Page caller conversations by recent activity', 'ConversationPage', request(interaction.page));
add('Chat', 'post', '/conversations', 'Start or reuse customer/worker conversation', 'Conversation', request(interaction.start, { workerId: '{{workerId}}' }, {
  status: 201, extraStatuses: [200], capture: { conversationId: 'id' }, description: 'New thread needs public non-self worker. Retained live key reused; tombstoned key returns 409 until explicit restore.' }));
add('Chat', 'get', '/conversations/{id}', 'Read original participant conversation', 'Conversation', request(interaction.id, undefined, { pathVars: { id: 'conversationId' } }));
add('Chat', 'get', '/conversations/{id}/messages', 'Page message history before sequence number', 'MessagePage', request(interaction.messages, undefined, {
  pathVars: { id: 'conversationId' }, description: 'Exclusive beforeNumber. Newest matching page returned in ascending messageNumber order. Original participant only; retained history readable if peer leaves.' }));
add('Chat', 'post', '/conversations/{id}/messages', 'Send immutable text as original participant', 'Message', request(interaction.message, { text: 'Hello, are you available?' }, {
  status: 201, pathVars: { id: 'conversationId' }, capture: { messageId: 'id' }, description: 'Both participants active. SQL allocates monotonic per-conversation number. Body trimmed, 1..2000 characters; no message edit route.' }));
add('Chat', 'delete', '/conversations/{id}/messages/{messageId}', 'Soft delete own message in live thread', null, request(interaction.messageId, undefined, { status: 204, destructive: true, pathVars: { id: 'conversationId' } }));
add('Chat', 'post', '/conversations/{id}/messages/{messageId}/restore', 'Restore own retained message in live thread', null, request(interaction.messageId, undefined, { status: 204, pathVars: { id: 'conversationId' } }));
add('Chat', 'delete', '/conversations/{id}', 'Starter soft deletes shared conversation', null, request(interaction.id, undefined, {
  status: 204, destructive: true, pathVars: { id: 'conversationId' }, description: 'Initiating customer only. Tombstones shared thread/messages/source history and related notifications for both parties.' }));
add('Chat', 'post', '/conversations/{id}/restore', 'Starter restores retained conversation', 'Conversation', request(interaction.id, undefined, {
  pathVars: { id: 'conversationId' }, description: 'Original accounts/profile must be live. Restores thread and source history; authors restore messages separately. No notification replay.' }));

add('Service requests', 'post', '/service-requests', 'Create immutable customer request details and appointment', 'Request', request(interaction.createRequest, {
  workerId: '{{workerId}}', details: 'Inspect the electrical panel', scheduledAt: '{{scheduledAt}}'
}, { status: 201, capture: { serviceRequestId: 'id', requestVersion: 'version' }, description: 'Public non-self worker required. Optional scheduledAt must be future epoch milliseconds. Parties/details/time immutable; no rescheduling endpoint.' }));
add('Service requests', 'get', '/service-requests', 'Page original participant requests', 'RequestPage', request(interaction.requests, undefined, { queryExample: { as: 'customer', limit: 50 } }));
add('Service requests', 'get', '/service-requests/{id}', 'Read original participant request', 'Request', request(interaction.id, undefined, { pathVars: { id: 'serviceRequestId' }, capture: { requestVersion: 'version' } }));
add('Service requests', 'patch', '/service-requests/{id}', 'Apply versioned actor-bound status transition', 'Request', request(interaction.updateRequest, { status: 'ACCEPTED', version: '{{requestVersion}}' }, {
  ...own, pathVars: { id: 'serviceRequestId' }, capture: { requestVersion: 'version' }, description: 'Worker: PENDING->ACCEPTED/DECLINED, ACCEPTED->COMPLETED. Customer: PENDING/ACCEPTED->CANCELLED. Read version first; stale version returns 409. Reason allowed only for decline/cancellation. SQL creates audit/reminders/history.' }));
add('Service requests', 'get', '/service-requests/{id}/events', 'Page immutable request events by version', 'RequestEventPage', request(interaction.events, undefined, { pathVars: { id: 'serviceRequestId' } }));
add('Service requests', 'delete', '/service-requests/{id}', 'Customer soft deletes terminal request', null, request(interaction.id, undefined, {
  status: 204, destructive: true, pathVars: { id: 'serviceRequestId' }, description: 'COMPLETED/DECLINED/CANCELLED only. Tombstones dependent reviews/events/history/reminders/notifications.' }));
add('Service requests', 'post', '/service-requests/{id}/restore', 'Customer restores retained terminal request', 'Request', request(interaction.id, undefined, {
  pathVars: { id: 'serviceRequestId' }, capture: { requestVersion: 'version' }, description: 'Requires live original accounts/profile. Restores original events/history without new status event; reviews restore separately. No reminder/notification replay.' }));
add('Reviews', 'get', '/workers/{id}/reviews', 'Page public worker reviews or own profile reviews', 'ReviewPage', request(interaction.reviews, undefined, { pathVars: { id: 'workerId' } }));
add('Reviews', 'post', '/workers/{id}/reviews', 'Create or update caller review with completed-request proof', 'Review', request(interaction.addReview, { requestId: '{{serviceRequestId}}', rating: 5, comment: 'Great work' }, {
  status: 201, extraStatuses: [200], pathVars: { id: 'workerId' }, capture: { reviewId: 'id' }, description: 'Caller must be completed request customer. One live user/worker review. Repeat POST updates existing live review with same original proof; different proof returns 409. New row after deletion gets new ID.' }));
add('Reviews', 'get', '/me/reviews', 'Page caller authored live reviews', 'ReviewPage', request(interaction.page));
add('Reviews', 'patch', '/reviews/{id}', 'Edit own review rating/comment', 'Review', request(interaction.editReview, { rating: 4, comment: 'Updated feedback' }, { pathVars: { id: 'reviewId' }, description: 'Rating required; immutable request/author/worker proof. Blank comment becomes null. No notification replay.' }));
add('Reviews', 'delete', '/reviews/{id}', 'Soft delete own review', null, request(interaction.id, undefined, { status: 204, destructive: true, pathVars: { id: 'reviewId' } }));
add('Reviews', 'post', '/reviews/{id}/restore', 'Restore own retained eligible review', 'Review', request(interaction.id, undefined, { pathVars: { id: 'reviewId' }, description: 'Source request still live/completed; no replacement live review for same user/worker. SQL recomputes rating on all changes.' }));

add('Health', 'get', '/health', 'API environment and version', 'Health', publicOp);
add('Health', 'get', '/config/app', 'App minimum version and legal link', 'AppConfig', publicOp);
add('Health', 'get', '/health/live', 'Process liveness', 'Liveness', { ...publicOp, root: true });
add('Health', 'get', '/health/ready', 'Database readiness and drain status', 'Readiness', { ...publicOp, root: true, extraStatuses: [503], description: '503 returns {success:false,status:"unavailable"}, without the ordinary error envelope.' });
