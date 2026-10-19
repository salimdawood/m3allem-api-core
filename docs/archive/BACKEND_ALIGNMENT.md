> Historical report. The development Neon branch was deleted on October 19, 2026. Retired environment backups now live in ignored `.archive/environments/`; one-time reset scripts and compatibility entry points have been removed. For current commands, use [README](../../README.md), [deployment](../DEPLOYMENT.md) and [seeding](../SEEDING.md).

# Backend alignment

## Completed: Prisma, authentication and accounts

`schema.sql` owns database structure and behavior. Prisma models represent all 29 application tables with numeric identities and tombstones. Check constraints, generated columns, deferred foreign keys, functions, views, partial indexes and exclusion constraints remain SQL responsibilities. Some inverse composite relations are represented as lists because Prisma cannot infer uniqueness from one unique component. This does not add database constraints.

`db:migrate` bootstraps an empty schema through psql. `db:preflight` is read only. Both prefer `DATABASE_URL_UNPOOLED`, falling back to `DATABASE_URL`; use a direct connection. Legacy Prisma migrations remain historical artifacts. Reset remains disabled; the seed entry points use a guarded separate development target. An existing UUID database requires its own data migration.

### API changes in this phase

- IDs in JSON bodies/responses are positive numbers. Path IDs are decimal numbers in URL text. SQL and Prisma use BIGINT; the API supports values through `Number.MAX_SAFE_INTEGER` and rejects precision loss. JWT `sub`/`sid` are decimal strings as token claims, parsed back to numbers for authorization.
- OTP send returns `challengeId`. Login verification, phone confirmation and recovery-email confirmation require that exact numeric ID with the code. HMAC input includes flow identity, purpose, destination, owner, nonce and code. Failed attempts commit before returning an error. Delivery failure invalidates the new challenge.
- Registration accepts name, optional nationality and private location. It accepts neither role nor an avatar URL. The five-minute registration token refers to a consumed login challenge, retired after registration. Create the account before uploading an avatar.
- User responses expose `isWorker`, `isAdmin`, `accountStatus` and `profileImageUploadId`. A worker profile grants worker capability; all accounts may hire. The account owns the canonical name/avatar, while public worker phone remains independent of private login phone.
- Access JWTs identify an account and session. HTTP requests and WebSocket handshakes check the current account and session; admin checks use current database state. Refresh rotation uses the SQL helper; reuse revokes that session family and commits before returning 401. Logout needs the access token and optionally an FCM token, and revokes its session immediately.
- Recovery issuance returns the same fields for known/unknown emails, with no challenge ID or developer code. Recovery verification uses email/code against the latest challenge in that account's recovery flow. Staging uses the configured fixed code. Recovery revokes older sessions before issuing a fresh session.
- Phone/email security changes revoke existing sessions; clients must authenticate again. Updating login phone leaves public worker phone unchanged.
- `DELETE /v1/me` soft deletes the account and its owned resources through SQL triggers. Account restoration is unavailable. Phone/email identifiers remain reserved.
- `PATCH /v1/admin/users/:id/status` accepts `{status:"SUSPENDED",reason:"..."}` or `{status:"ACTIVE"}`. It checks the acting admin again in the transaction and disallows self moderation. Reactivation requires fresh authentication; it does not restore old sessions/admin grants/devices.
- Account profile/settings, favorites, devices, contact history and notification reads use numeric relationships and tombstones. Favorites/settings restore retained keys. Notifications expose `requestId`, `conversationId`, `workerId`, `readAt`, `createdAt`; contact history exposes typed targets. CALL/WHATSAPP input accepts worker ID and interaction type, without an arbitrary reference string. Historical worker names are read from the retained account row.
- WebSocket delivery checks session state before publishing. Logout/account moderation endpoints close matching sockets. Other database-driven revocations close idle sockets on a 15-second check; access expiry also closes them.

### Validation

Run `npm run db:generate`, then `npm run test:auth-account` with the local test PostgreSQL instance running. The suite creates a new `m3allem_backend_test_*` database on `127.0.0.1:55436`, applies SQL plus synthetic fixtures, reads all Prisma models and exercises HTTP auth/account flows, avatar ownership, WebSocket session checks and concurrent refresh reuse. It never uses the application database URL. PostgreSQL 17.4 is the tested version. External SMS/email, storage and Firebase delivery are not exercised.

## Completed: catalog and worker profiles

Catalog uses the SQL localization helpers, active resource views and English fallback. Responses include numeric IDs and stable slugs, honor weighted `Accept-Language` preferences and use `Vary: Accept-Language`. Catalog ETags support weak/list validators and revalidate cached content. Banner locale falls back to English only when the requested language has no currently visible banners; scheduling, tombstones and category availability are enforced by SQL.

### Worker input and lifecycle

Any active account can create one worker profile. Worker routes use authenticated ownership checks inside write transactions. Exclusive role checks and role arguments have been removed from this module. There is no automatic verification.

Create/update body:

```json
{
  "publicPhoneNumber": "+96170123456",
  "whatsappNumber": null,
  "categoryId": 1,
  "workerTypeIds": [5],
  "description": "Electrical repair and maintenance",
  "experienceYears": 3,
  "startingPrice": {"amount": 50, "currency": "USD", "unit": "PER_JOB"},
  "services": [{"name": "Inspection", "price": null}],
  "workingHours": {
    "timeZone": "Asia/Beirut",
    "shifts": [{"isoWeekday": 1, "opensAt": "22:00", "closesAt": "02:00", "endDayOffset": 1}]
  },
  "location": {"latitude": 33.89, "longitude": 35.5},
  "isAvailable": true,
  "isListed": true
}
```

Obtain category/type IDs from catalog. Array order defines the primary type at position zero. Category is fixed after profile creation because retained historical type links reference that category. Name/avatar are read from the owning account; worker input does not accept copies or avatar URLs. Public phone is independent of account login phone.

`PUT /v1/workers/:id` replaces editable fields and selected child lists. Include existing numeric `id` values in services/shifts to keep their identity. Omitting an ID creates a new row; omitting an existing child tombstones it. Supplying a retained child ID restores and edits that child in separate statements within one transaction. Child IDs must belong to this worker. Type links retain their composite keys and restore when selected again. Duplicate IDs/types are rejected.

- `PUT /v1/workers/:id/listing` accepts `{isListed:false}` to hide discovery.
- `PUT /v1/workers/:id/availability` accepts `{isAvailable:false}`; unavailable workers remain visible unless filtered.
- `DELETE /v1/workers/:id` tombstones the profile and owned children without deleting history.
- `POST /v1/workers/:id/restore` accepts the complete editable body. It restores the same profile and selected children. The retained profile prevents creating another profile for that account. Discounts, old verification and other users' favorites are not automatically restored. A fresh identity submission/review is required before public discovery.

Private `GET /v1/me/worker` returns the live owned profile even if unlisted/unverified. Public detail/search read `public_worker_profiles`, requiring an active account, listed/verified profile and enabled catalog/primary type. Tombstoned rows are excluded.

Prices are either a complete amount/currency/unit triple or null (quote required). Zero is explicitly free. Amounts use at most two decimal places. Discounts affect only starting price, with effective price rounded to two places. Percentage allows up to 100; fixed amount allows equality with base price and requires matching currency/unit. `PUT /v1/workers/:id/discount` replaces the live discount with a new retained record. `DELETE` tombstones it. Expired discounts are hidden publicly and do not affect effective price, but must still satisfy integrity rules until removed. Invalid price/discount changes roll back together.

Schedules use numeric ISO weekdays, named database-recognized time zones, multiple shifts per day and explicit next-day offsets. Offset 1 with equal opening/closing times means 24 hours. Positive duration, maximum 24 hours and overlap rules include Sunday-to-Monday wrap. Adjacent shifts are allowed. Empty shifts means no declared hours.

### Discovery and pagination

Search supports numeric category/type filters, minimum rating, availability, active discounts, favorites, coordinates/radius and current full-text source documents. Full-text relevance includes current account names, services, catalog translations and keywords. Search does not read a stale joined cache. Favorite-worker expansion uses the same worker representation.

Sorts are `RELEVANCE` (score descending), `RATING` (descending), `DISTANCE` and `PRICE` (ascending), with numeric worker ID breaking ties. `PRICE` requires both `currency` and `priceUnit`; matching filters exclude other currencies/units and quote-only rows. Distance sort/radius requires both latitude and longitude. Booleans accept only `true`/`false` query strings.

Search returns `{items,nextCursor}`. Cursors carry the last sort value and worker ID and are bound to the authenticated account, filters and sort; page size may change. They are not offsets. Values can change while scrolling; this is not a database snapshot. Nearby returns at most the requested limit, ordered by distance.

Writes serialize on the account/profile, retry deadlock/serialization failures up to twice and explicitly check deferred constraints before commit so validation errors retain their SQLSTATE. Search throughput and maximum-sized edit latency have not been benchmarked against production data.

Run `npm run test:worker-catalog` using the same isolated local PostgreSQL instance. It creates a fresh `m3allem_worker_test_*` database and checks catalog caching/localization, profiles, ownership, retained children, schedules, discounts, search/cursors, favorites, concurrent creation and restoration. The auth/account suite also passes with these integrations. Schema SQL is unchanged by this phase.

## Completed: uploads and identity verification

### Account-owned uploads

`POST /v1/uploads/profile-image` and `/v1/uploads/identity-document` accept one multipart `file` from an existing authenticated account. Registration tokens, extra multipart fields and oversized files are rejected. Limits are 5 MiB for avatars and 10 MiB for identity files, checked again after processing. Type detection inspects bytes. Images are decoded with a 25-million-pixel limit, oriented, resized, stripped of metadata and re-encoded as JPEG; animated/multi-page images are rejected. Avatars accept JPEG/PNG/WebP; identity files accept JPEG/PNG/PDF. PDFs retain original bytes and receive a signature/end-marker check. This is not a full PDF parser or malware scan.

Storage location is assigned by the server. The API first commits a pending `file_uploads` record, performs the external write, then commits ready state with SHA-256, content type, byte count and upload time. S3 writes request checksum verification and AES256 encryption. Avatar and identity bucket names must differ. Avatar URLs use the configured public base; identity objects require a private bucket policy. Actual provider policies/operations are not exercised by local validation.

Uploads return 201 with a numeric `id`, purpose, status and metadata. Avatar uploads additionally return `url`; identity upload responses contain no public URL or storage key. Attach an avatar with `PATCH /v1/me` using `{profileImageUploadId:<id>}`. Uploading alone does not attach it.

- `GET /v1/uploads?afterId=<id>&limit=<1..200>` lists the caller's live upload metadata, including pending/failed records. Default limit is 50; pagination returns `nextAfterId`.
- `GET /v1/uploads/:id` returns an owner's metadata and, when ready, its access URL. A ready avatar attached to an active account may also be resolved by other authenticated accounts. Private identity access here is owner-only, including for admins. Identity URLs expire after 300 seconds.
- `DELETE /v1/uploads/:id` tombstones an owned upload only when no live avatar/document reference remains. It retains the object and all metadata. API tombstones do not erase bytes or revoke already issued URLs.
- `POST /v1/uploads/:id/restore` restores the same owned ready record; failed, unfinished or physically deleted objects cannot be restored through this route. It does not attach the avatar or restore a submission.

Failed storage writes leave failed records. Finalization failure after a successful write retains bytes and records the failure where possible, even if account/upload deletion occurred during the write. A process crash can leave pending work for reconciliation. There is no automatic object purge: cleanup deadlines identify orphan review eligibility only. Storage operations are not performed inside retried database transactions. Upload responses and private review routes use `Cache-Control: no-store`.

### Identity submissions and admin decisions

`POST /v1/me/worker/identity-documents` accepts `{type:"PASSPORT",uploadId:<numeric ID>}`; types also include `NATIONAL_ID` and `DRIVERS_LICENSE`. The upload must be ready, private identity content owned by the active worker account and never previously submitted. Each submission starts pending. The old `AUTO_APPROVE_VERIFICATION` option has been removed. Storage references, reviewer IDs and status cannot be supplied by the client.

The database assigns monotonic submission numbers and the current pointer. A new submission makes the worker pending immediately and preserves older submissions/review metadata. Finalized decisions cannot be changed, and superseded pending submissions cannot be reviewed.

- `GET /v1/me/worker/identity-documents/current` reads the explicit current live submission. It returns 404 when absent; it never falls back to older approvals.
- `GET /v1/me/worker/identity-documents?afterId=<id>&limit=<1..200>` returns retained live submission history with `isCurrent`, numeric upload/submission/reviewer IDs and review metadata.
- `DELETE /v1/me/worker/identity-documents/:documentId` tombstones an owned submission. Removing the newest produces `NOT_SUBMITTED`; older approval is not reused. Detaching a document does not delete its upload bytes. Submission restoration is not exposed; use a fresh upload/submission for a new review.
- `GET /v1/admin/verifications` returns a bounded page of current pending submissions from active accounts, excluding the acting admin's own worker profile. It returns metadata/name but no signed URLs. It supports `afterId`, `limit` and optional `status=PENDING`.
- `GET /v1/admin/verifications/:documentId/document` rechecks admin authority and current pending eligibility, then returns a 300-second private URL. Already issued URLs remain valid until their storage expiry even if eligibility later changes.
- `POST /v1/admin/verifications/:documentId/approve` accepts an empty body. `/reject` requires `{reason:"..."}`. Both record the authenticated admin; self review is forbidden. Accounts are locked in numeric order, then the worker and document, to serialize reviews/submissions and recheck admin authority inside the transaction. Conflicting/finalized/superseded decisions return 409.

Successful reviews atomically create a typed `VERIFICATION_UPDATE` notification. SQL enqueues one durable delivery per eligible device. This module publishes realtime events after commit and does not call the obsolete direct push implementation. Delivery workers are the next separate phase.

Run `npm run test:upload-verification` on the isolated local instance. It creates `m3allem_upload_test_*`, uses real SQL, HTTP multipart requests and image processing, and substitutes storage writes/signing in memory. It covers ownership, byte metadata, soft deletion/restoration, storage failure, submission history, current-only review, durable notifications, concurrent decisions, authorization rechecks and deletion during upload. External S3/SMS/email/Firebase calls are not exercised. Schema SQL is unchanged by this phase.

## Completed: conversations, requests and reviews

All interaction IDs are numeric. Participant identity comes from authenticated sessions, and SQL retains original participants even when a worker profile/account later leaves. The remaining exclusive-role adapter and role arguments have been removed. Worker-capable accounts may hire other workers. Private request DTOs no longer disclose private login phone numbers.

Database writes lock participant account rows in numeric order, then resource rows, and use the shared transaction helper with bounded deadlock/serialization retries and explicit deferred-constraint validation. Notifications are created in the same transaction as their source action. SQL creates contact history, request events, reminders and delivery queue rows; the application does not duplicate that work or call the legacy direct push service.

### Conversations and messages

- `POST /v1/conversations` accepts `{workerId:<id>}`. New threads require a current public worker and cannot target the caller's own profile. Repeated/concurrent starts reuse the retained customer/worker key and return the same thread. An existing live thread remains readable when discovery changes. A tombstoned thread returns 409 and requires explicit restoration.
- `GET /v1/conversations` returns `{items,nextCursor}` ordered by latest active message activity and ID. Detail and message routes require one of the two original participants; admins have no chat-content bypass.
- `POST /v1/conversations/:id/messages` accepts `{text:"..."}` and returns 201. Sender is authenticated, content is immutable and trimmed, and SQL assigns the next per-conversation message number from all retained history. Both accounts must be active to send; existing messages remain readable when the other account leaves.
- `GET /v1/conversations/:id/messages?beforeNumber=<n>&limit=<1..200>` returns `{items,nextBeforeNumber}`. The bound is exclusive. The most recent matching page is returned in ascending message-number order; timestamps are not used as message cursors.
- `DELETE /v1/conversations/:id/messages/:messageId` and `POST .../:messageId/restore` operate only on the caller's own messages in a live thread. Tombstones retain the number, content and original sent time; numbers are never reused. SQL derives conversation summaries from the latest live message.
- `DELETE /v1/conversations/:id` is restricted to the initiating customer. This tombstones the shared thread, messages and related notification/history resources for both participants. `POST .../:id/restore` restores the thread and its source contact-history row when the original accounts/profile are live. Messages stay tombstoned until their individual authors explicitly restore them; notifications/deliveries are not replayed.

New-message notifications use a generic body and typed conversation target, so deleted message text is not copied into new inbox previews. Realtime messages include numeric sequence values and clients can refetch current summaries/history after changes.

### Requests and transition history

`POST /v1/service-requests` accepts `{workerId:<id>,details?:"...",scheduledAt?:<epoch milliseconds>}`. A supplied appointment must be in the future. Details and scheduled time remain fixed after submission. The response includes version 1 and the authenticated customer as the initial actor. Both initial notifications target the request ID.

`PATCH /v1/service-requests/:id` requires `{status:"ACCEPTED",version:<last read version>}`; optional nonblank `reason` is allowed only for decline/cancellation. Stale versions return 409 without another event. Valid transitions are:

| Actor | Current state | Next state |
| --- | --- | --- |
| Assigned worker account | PENDING | ACCEPTED or DECLINED |
| Assigned worker account | ACCEPTED | COMPLETED |
| Original customer | PENDING or ACCEPTED | CANCELLED |

SQL records actor, reason, version and timestamp in immutable events. `GET /v1/service-requests/:id/events?afterVersion=<n>&limit=<1..200>` returns `{items,nextAfterVersion}` in ascending version order. Only original participants can read details/events. A remaining active customer can still cancel after the other account is deleted; inactive recipients receive no new notification.

`GET /v1/service-requests?as=customer|worker&status=<optional status>` returns a bounded `{items,nextCursor}` page. `as` defaults to customer. The worker view uses retained participant identity, including requests whose original profile is later deleted. Acceptance synchronizes scheduled reminders through SQL; completion, decline and cancellation update their eligibility through SQL.

`DELETE /v1/service-requests/:id` is restricted to the original customer and terminal requests (COMPLETED, DECLINED, CANCELLED). Active requests must be resolved first. Source deletion tombstones events, reminders, notifications, contact history and dependent reviews. `POST .../:id/restore` requires live original accounts/profile and restores the same terminal request, contact record and original event history without creating another status event. Reviews stay tombstoned until their authors explicitly restore them; notifications/reminders are not replayed.

### Reviews and ratings

`POST /v1/workers/:id/reviews` requires `{requestId:<completed request ID>,rating:<1..5>,comment?:"..."}`. The completed request must belong to the authenticated customer and target this worker. Self reviews are forbidden. A first live review returns 201; posting again edits that same live review and returns 200. Its originating request, author, worker, ID and creation time remain fixed. A different proof on an existing live review returns 409.

`PATCH /v1/reviews/:id` edits rating/comment for the author. Whitespace-only comments become null. `DELETE /v1/reviews/:id` tombstones it; `POST .../:id/restore` restores the original row only when its source request is still live/completed and there is no other live review for this user/worker. A fresh POST after deletion may create a new retained review row; this prevents restoration of the older row until the replacement is removed.

Eligibility is based on the completed request, so hiding a worker listing does not prevent a customer editing their valid review. `GET /v1/workers/:id/reviews` follows current public-worker visibility, with private access for the active owner of that profile. `GET /v1/me/reviews` returns the caller's live authored reviews, including retained worker names after a worker leaves. Both use bounded `{items,nextCursor}` pages.

SQL serializes review changes with the worker and recalculates rating/count on create, edit, tombstone and restore. Worker-profile restoration also reconciles rating/count from live reviews, because authors may remove reviews while the profile is tombstoned. Only new review records generate a new-review notification; edits/restoration do not replay it.

### Collection cursors and validation

Conversation, request and review collections use keyset cursors with the last timestamp and numeric ID. Timestamp cursors retain PostgreSQL microseconds and are validated before use. Cursors are bound to the authenticated caller, resource collection and its filters; page size may change. Default limit is 50, maximum 200. Conversation activity and visibility can change while scrolling; collection pages are not a snapshot.

Run `npm run test:interactions` on the isolated local PostgreSQL instance. It creates `m3allem_interaction_test_*` and exercises real HTTP and SQL, including participant restrictions, idempotent/concurrent starts, message sequences, soft deletion/restoration, typed notifications, versions/events, reminders, completed-request proofs, concurrent rating updates, cursor validation and deleted-peer history. External push delivery is not exercised. The standalone schema is unchanged.

## Completed: reminder and push workers

Reminder discovery is bounded. Materialization locks and rechecks the recipient, request, settings and reminder before inserting one typed inbox notification. SQL records its notification ID and queues eligible devices; the job does not duplicate schedule/history creation. Cancelled, expired, disabled or deleted appointments are excluded. Realtime publication follows commit.

Push workers claim due rows with `FOR UPDATE SKIP LOCKED`, increment attempts/claim version and assign a 90-second lease. Claims are taken just before sending, with four concurrent lanes and at most 100 claims per cycle. Expired claims can be reclaimed; stale or expired acknowledgements cannot change the newer claim. Account status, opt-out, inbox visibility, exact device ownership/token and reminder eligibility are checked again before external I/O. Provider calls run outside database transactions.

Firebase credential readiness is checked before claims. Provider calls have a 25-second application timeout; the underlying SDK request may still complete afterward. Transient failures use persisted exponential backoff with jitter and at most the row's configured maximum attempts (default five). Permanent payload failures stop retries. Invalid registration tokens soft delete only the still-matching device binding, retaining delivery history. Logs retain error codes and delivery IDs rather than provider payloads/tokens.

`SENT` means Firebase accepted the message, not that a handset received it. A provider success followed by a failed database acknowledgement leaves the lease for recovery. Delivery is at least once; duplicates are possible, including after timeout. Clients must deduplicate with `notificationId`. Firebase data fields are strings as required by that transport, including typed target IDs and reminder appointment milliseconds; HTTP JSON IDs remain numeric. Reminder Android TTL is bounded by appointment time and one hour.

`PUSH_DELIVERY_ENABLED=false` leaves the queue untouched. With no explicit value it is enabled only in production; `.env.example` sets false. Recurring jobs do not overlap their own runs. Shutdown stops new work and awaits active lanes, reminders and connections before disconnecting Prisma, with a configurable 60-second deadline. Forced termination leaves leases for recovery.

The schema's account-suspension function now soft deletes devices through the active view; its previous physical DELETE conflicted with the global deletion guard. Device and delivery rows remain retained. An already installed numeric schema needs a reviewed function migration for this change; no live database was modified.

Run `npm run test:delivery-workers` on the isolated local PostgreSQL instance. It creates a fresh `m3allem_delivery_test_*` database and tests SQL materialization, concurrent claims, fencing, retries, expiry, ownership transfer, opt-out, suspension, timeouts, acknowledgement recovery and job draining. Firebase is substituted, so actual provider credentials/network delivery remain unverified.

## Completed: HTTP documentation and Postman reconciliation

API.md, OpenAPI 3.1 and Postman now share the documented operation inventory in `scripts/api-contract.js`. Input structures come from the actual Zod route validators; response schemas and domain descriptions are maintained explicitly against services and SQL. `npm run docs:generate` (also `postman:generate`) regenerates all artifacts. `npm run docs:check` compares all 84 HTTP routes, resolves schema references, validates example bodies and Postman numeric substitution, compiles Postman scripts and detects generated artifact drift. These are local static checks; they do not call the API or external providers.

The references describe registration bearer tokens, exact OTP challenges, rotated session tokens, numeric catalog/entity IDs, independent worker/admin capability, request versions/events, completed-request reviews and supported deletion/restoration. Postman captures tokens and IDs from real responses instead of UUID fixtures/fabricated refresh tokens. Ordered onboarding/request journeys document separate customer/worker/admin accounts, trusted admin provisioning and alternative lifecycle branches. The normal SQL bootstrap seeds catalog only.

The existing timestamp difference is explicit: notification/contact-history reads serialize database dates as ISO strings, most DTOs use epoch milliseconds, and realtime notifications vary by producer. Worker realtime updates may be partial. Clients should refetch HTTP state and deduplicate push by notification ID. There is no Android client source in this workspace, so no client implementation was changed or validated. Existing backend suites cover the local component flows; a full real-provider/client journey still needs its deployment environment.

## Remaining phases

1. Apply the documented payload/session/lifecycle changes in the client repository and validate full client journeys with actual providers.
2. Configure real delivery providers through environment variables and validate their deployed journeys when credentials are available. Current development delivery uses explicit mock mode.

Production `neondb` was explicitly reset and seeded on October 17; see [PRODUCTION_RESET.md](PRODUCTION_RESET.md). The legacy rows were replaced, with a pre-reset snapshot retained. Client reconciliation and real provider validation remain.
