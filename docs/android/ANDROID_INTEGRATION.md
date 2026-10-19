# Android integration contract

## Network and environments

Use `{{API_ORIGIN}}/v1/` as the Retrofit base URL. Endpoint annotations are relative,
such as `auth/otp/send`, `catalog`, or `workers`; do not start them with `/` or the
`v1` base segment is discarded by URL resolution. HTTPS works on device and emulator;
the hosted API is not localhost. Android needs INTERNET permission. Handle initial
request latency and network failures with cancellable requests and an appropriate
timeout; never blindly replay non-idempotent writes after an uncertain result.

The Neon branch is named `production`, but deployed `/v1/health` currently reports
`staging`. That branch name is not the Android flavor or proof that real OTP/push
delivery is enabled. The backend uses synthetic seed data for these QA accounts.

## Authentication

1. POST `auth/otp/send` with `{phoneNumber:"+961..."}` returns challengeId.
2. POST `auth/otp/verify` with `{phoneNumber,challengeId,code:"111111"}` using the
   returned numeric challengeId. EXISTING_USER returns user and nested tokens.
3. NEW_USER returns a registrationToken. POST `auth/register` with that bearer
   token and `{fullName,nationality?,location?}`. No role, admin flag or avatar URL
   is accepted. Registration returns user and nested tokens.
4. Other protected requests use `Authorization: Bearer <accessToken>`.
5. POST `auth/refresh` with `{refreshToken}` returns a bare token pair. Access JWTs
   last 900 seconds; rotation consumes the refresh token. Reuse revokes the session
   family. Serialize refresh and atomically replace both values. Do not loop refresh
   when the refresh endpoint itself returns 401; clear the session and show login.
6. POST `auth/logout` requires access auth and accepts optional fcmToken, not a
   refresh token. Account deletion has no restore. Phone/email changes, recovery,
   suspension and admin removal can invalidate existing sessions and sockets.

Store application session credentials securely using the Android app's existing
credential storage strategy. Keep the customer/worker/admin Postman QA identities
separate; the app ordinarily uses the current user's pair. Staging fixed OTP is
test behavior, not something the Android client should enforce for future releases.

## DTO and error rules

| Value | Android handling |
| --- | --- |
| ID, message number, request version | Long, numeric JSON, positive, max 9007199254740991 |
| OTP | String, exactly six digits, preserve leading zeros |
| Normal DTO timestamps | Long epoch milliseconds; nullable where documented |
| Inbox readAt/createdAt, contact-history createdAt, health timestamps | ISO 8601 String parsed as an instant |
| Price | Complete amount/currency/unit triple or null; 0 is free, null means quote |
| Response bodies | Direct object or array; no global data wrapper |
| Empty success/cache response | 204/304, do not JSON-decode an empty body |
| Errors | `{error:{code,message,details?},requestId}` |
| Readiness 503 | `{success:false,status:"unavailable"}` |

Handle 400 validation, 401 expired/revoked auth, 403 permission, 404 unavailable or
hidden resource, 409 concurrent/lifecycle conflict, 413 size, 415 format, 429 rate
limit and transient 5xx separately. Capture requestId without recording tokens or
private file content. Follow server resend/rate-limit behavior. Notifications and
history have different timestamp types from most DTOs; do not use one universal adapter.

## Pagination

| Collections | Input -> response continuation |
| --- | --- |
| Workers, conversations, service requests, reviews | cursor -> nextCursor |
| Conversation messages | beforeNumber -> nextBeforeNumber |
| Upload and identity submission lists / admin queue | afterId -> nextAfterId |
| Request events | afterVersion -> nextAfterVersion |

Null means the end. Messages are returned oldest-to-newest inside the selected recent
page; prepend older pages without changing messageNumber order. Preserve filters/account
when reusing a cursor. Nearby/favorite expansion, notification inbox and contact history
are bounded arrays; no continuation is currently exposed for their retained older records.

## Worker and request lifecycle

Any active account can own one worker profile and still hire another worker. Public
worker discovery requires an active owner, verified/listed profile and enabled catalog.
`GET me/worker` can read the owner's unverified/unlisted live profile. Catalog IDs are
numeric and localized with weighted Accept-Language (en/fr/ar); settings language is separate.

Worker PUT replaces selected services/shifts/types. Include retained service/shift IDs
to edit existing children; omission creates replacements/tombstones omitted children.
Category is fixed after creation; first workerTypeIds item is primary. Working hours
use named timeZone, ISO weekday 1..7, HH:mm times and explicit endDayOffset for overnight
shifts. A restored worker requires new identity verification for public discovery.

Service request creation fixes original parties/details/time. There is no reschedule
endpoint. Worker may accept/decline PENDING and complete ACCEPTED; customer may cancel
PENDING/ACCEPTED. Status PATCH requires latest version; reason applies to decline/cancel.
Only the original customer with a completed request can review that worker. Conversation
and request histories are participant-private; admin does not bypass chat authorization.

## Realtime and push

Connect to `{{WS_URL}}` with the access bearer header on the upgrade request. The
initial event is `{event:"connected",data:{userId:<number>}}`. Server events include
message.created/deleted/restored, conversation.updated/deleted, request.created/updated/
deleted/restored, worker.updated/deleted, favorites.updated and notification.created.
Worker updates may be partial; refetch current HTTP state rather than replacing a DTO
with an incomplete event. HTTP remains the source of truth.

Use POST messages over HTTP. Sending a client WebSocket message closes the connection
with 1008. Auth expiry/revocation closes with 4401. Reconnect with backoff and a fresh
access token, then refetch missed state; there is no replay, delivery ACK or typing API.
Do not send application-level ping messages to this implementation; WebSocket control
ping frames are separate and supported by the ws transport.

Register an actual Firebase Android device token through the Devices endpoints. Inbox
notifications and WebSocket events work independently of handset push. FCM data fields
are strings (including numeric IDs and scheduledAt); deduplicate using notificationId.
Production delivery is at least once. Device registration success does not verify FCM delivery.
