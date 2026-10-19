# M3allem Postman guide

Generate with `npm run docs:generate` (or the existing `npm run postman:generate`). Both regenerate API.md, OpenAPI, the collection and local environment from [api-contract.js](../scripts/api-contract.js) and current route validators. The generator does not read application credentials or connect to any database.

## Setup

1. Import `M3allem_API.postman_collection.json` and `M3allem_Local.postman_environment.json`. The current local API is `http://localhost:3001`; `baseUrl` derives from `rootUrl` as `{{rootUrl}}/v1`. For a hosted or teammate-accessible API, import `M3allem_API_Server.postman_environment.json` and replace its placeholder `rootUrl` with the actual API origin, without `/v1` or a trailing slash. No hosted API URL exists yet. Neon database/storage URLs are not API URLs.
2. The default collection phones match the current synthetic seed: customer `+96170000001`, worker `+96170000002`, admin `+96170000003`. The single Neon branch is named `production`, but the API deliberately runs in **staging/mock mode**, with OTP `111111` and push off. There are no pre-issued tokens in these shared files. For fresh accounts, change the phone variables. A worker account can also hire; customer/worker/admin names identify separate example actors.
3. Use an account setup login folder: send OTP, then verify that exact challenge. Successful responses save the account's access/refresh tokens and numeric identity. `otpCode=111111` applies only when it matches your configured staging fixed code. Production sends a real OTP; set its exact six digits.
4. A NEW_USER response saves `registrationToken`. Run exactly one registration alternative using that proof. Customer registration saves customer tokens; the alternative saves worker tokens. Use a fresh phone/proof for the second account. Registration accepts no role.
5. Admin authority must already be provisioned through a trusted operations process. Registering an account or selecting the admin login folder does not grant it.

The old development Neon branch was deleted. Use the current API configuration against `production/neondb`; no seeding/reset is needed to use this collection. After logging in, fetch Catalog to capture compatible category/type IDs, then Workers → Read own live worker profile using the worker token to capture its actual `workerId`. Database IDs are captured from responses rather than assumed from example response bodies.

When an environment with `rootUrl` is selected, captured IDs and tokens are saved to that environment so refresh/logout updates the same values used by requests. Without an environment, they are saved to collection variables. Numeric body variables are unquoted in raw JSON and checked before sending. Select actual files for multipart upload requests; there is no machine-specific path committed. Never share exported tokens.

To prepare ready-to-use local credentials, start the staging/mock API and run `npm run postman:login`. Import the resulting `M3allem_Local_Authenticated.private.postman_environment.json` and select it with the updated collection. This ignored private file includes real customer/worker/admin access and refresh tokens, account IDs and the existing worker/category/type IDs. Shared environments remain credential-free. Access tokens expire after 15 minutes; use Sessions → the matching actor → Refresh to update both tokens. Regenerating documentation does not overwrite the private file.

Every request includes illustrative response examples. Expand a request's Examples in Postman to see DTO shape; these are synthetic documentation, not captured server responses or usable credentials. Login includes separate NEW_USER and EXISTING_USER examples. 204/304 responses intentionally have no JSON body. Run requests to obtain actual values.

## Quick check with existing seeded accounts

1. Select the intended environment, start the API, and run Health → Process liveness, then Database readiness.
2. Run Account setup → Authenticate customer account, Authenticate worker account and, if needed, Authenticate admin account. Each folder sends then verifies its own OTP challenge and saves that actor's tokens. Avoid immediate repeat sends to the same phone: the resend delay is 30 seconds.
3. Fetch Catalog, then Workers → Read own live worker profile. Worker detail/search now use the captured worker ID and customer authentication.
4. Use Conversations to start/reuse a thread and send messages, or run Request completion journey in order. Those requests write synthetic test data.
5. Use Sessions → the relevant actor → Refresh to rotate and save the correct pair. Logout clears only that actor's captured tokens. These session folders contain alternatives; do not run all sessions as a single workflow.

Do not run the entire collection with Collection Runner. Registration alternatives, refresh/logout, approval/rejection and lifecycle changes are intentionally separate choices.

## Android developer notes

| Where the client runs | API origin while backend runs on your PC |
| --- | --- |
| Postman desktop on the backend PC | `http://localhost:3001` |
| Standard Android Studio emulator on that PC | `http://10.0.2.2:3001` |
| Physical phone or a teammate's computer | `http://<backend-PC-LAN-IP>:3001`, on a reachable network with the port allowed |
| Hosted API | Actual deployed HTTPS origin, once available |

Append `/v1` for app endpoints; root health endpoints omit it. Android `localhost` refers to the device itself. Local HTTP requires an appropriate Android debug network-security configuration; use HTTPS for a hosted release.

- Send `Authorization: Bearer <accessToken>` for protected requests. Keep access/refresh pairs per account, refresh once per rotation, and save both returned tokens together. An unsuccessful session refresh requires login again.
- IDs, versions and message numbers are JSON integers. Use Kotlin `Long`; send numbers, not quoted IDs or UUIDs. The API caps values at `Number.MAX_SAFE_INTEGER`. OTP is a six-character string. Most timestamps are epoch milliseconds; notification/contact-history timestamps are ISO 8601 strings.
- Responses are direct objects/arrays, not a universal `data` wrapper. Handle empty 204/304 bodies. Errors use `{error:{code,message,details?},requestId}`; readiness 503 is `{success:false,status:"unavailable"}`.
- Public worker discovery requires a listed, verified worker. Ownership, worker capability and admin authority are separate. A registration token is only for registration; uploads need an existing account's access token.
- Multipart uploads use one `file` field. Keep returned numeric upload IDs for profile attachment/identity submission. The identity upload response has no public URL; authorized reads return expiring URLs.
- Pagination varies: worker/conversation/request/review lists use `nextCursor`; messages use `nextBeforeNumber`; upload/identity lists use `nextAfterId`; request events use `nextAfterVersion`. Preserve the same filters/account when following a cursor.
- Realtime connects to `ws://<host>:3001/v1/realtime` locally or `wss://<host>/v1/realtime` over HTTPS, with the bearer header during upgrade. Tokens in the URL are rejected. Client messages are unsupported; refetch HTTP state after events, reconnect with a fresh token, and deduplicate push by `notificationId`. The JSON collection covers HTTP; it does not automate WebSocket testing.

## Worker onboarding

1. Authenticate/register the worker account and a separate admin account.
2. Get catalog; response captures a compatible category/type pair. Adjust the create-worker body for the actual service. Create worker saves `workerId` and `workerUserId`.
3. Upload private identity document as worker (select file), then submit its captured `identityUploadId`. Submission saves `documentId`.
4. Admin fetches the pending queue and scoped document link, then runs approve **or** reject. Only the current pending non-self submission can be reviewed. Rejection needs a fresh submission for another decision.
5. Confirm `/me/worker` and public worker detail/search. Public discovery requires live/listed/verified worker and enabled catalog.

Updating/restoring a profile replaces selected children. Include existing service/shift IDs to keep them; the example without IDs creates replacements and tombstones previous children. Restore requires a fresh verification before public discovery. Catalog IDs come from catalog responses, not hardcoded slugs.

## Request completion

With a public verified worker and both account tokens saved, run the **Request completion journey** in order:

1. Customer creates request; saves request ID/version and a future appointment.
2. Worker accepts using that version; saves returned version.
3. Worker completes using the new version.
4. Customer reviews using the completed request ID.
5. Fetch immutable events as the original customer.

Decline/cancellation are alternative branches. For those, edit status/reason and choose the correct actor's bearer token; reason is allowed only for decline/cancellation. After a 409, refetch the request rather than inventing a version. The worker request list uses `as=worker`; customer is the default.

## Chat, notifications and security

- Customer starts/reuses conversation, then sends a message. To reply as worker, select `workerAccessToken` as bearer; the generic message example defaults to customer. Only original participants have access, including when an admin is logged in.
- Inbox reads save the first notification ID for mark-read. Register a real device token to exercise handset delivery. Push must be enabled and Firebase configured separately; inbox availability does not prove Firebase/handset delivery. Deduplicate push by notification ID.
- Sessions includes separate refresh/logout requests for customer, worker and admin. Never reuse consumed refresh tokens: reuse revokes that session family. Logging in with NEW_USER clears that actor's previous captured token pair before registration.
- Phone/recovery-email confirmation and moderation revoke existing sessions. Authenticate again before further requests. Account deletion has no restore.
- Lifecycle/security changes are grouped separately. Run them deliberately on dedicated local resources. They are not part of the happy path.

The full collection is a request reference, **not one runnable scenario**: fresh registration alternatives, approve/reject branches, account moderation and deletion conflict when executed together. Read [API.md](../docs/API.md) for response schemas, pagination, timestamp representations and lifecycle rules. No external provider or remote database is contacted by generation.
