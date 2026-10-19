> Historical report. The development Neon branch was deleted on October 19, 2026. Retired environment backups now live in ignored `.archive/environments/`; one-time reset scripts and compatibility entry points have been removed. For current commands, use [README](../../README.md), [deployment](../DEPLOYMENT.md) and [seeding](../SEEDING.md).

# Schema and API investigation

Historical snapshot from before the schema redesign. The current definition is `schema.sql`; see `DEPLOYMENT.md` and `validation/latest-result.json` for deployment guidance and current validation evidence. Findings below describe the original files.

Reviewed 2026-10-16. Static review of `schema.sql`, `API.md`, the initial SQL migration, Prisma models, and the relevant Express repositories/services. No SQL was executed, no database was accessed, and no runtime or concurrency tests were run. Findings about concurrent execution below are risks inferred from the code.

The initial migration currently has the same lines as `schema.sql`. Changes must account for both the standalone schema and the migration history. The Android source referenced by the documents is absent from this workspace, so compatibility with its actual models is unverified.

## Highest priority fixes

### 1. Verification has no authoritative current submission

Evidence: [schema.sql:217](../../database/schema.sql#L217), `src/modules/verification/verification.repository.js` (`current`, `pending`, `review`), and `verification.service.js` (`review`).

Multiple pending identity documents can exist for one worker. The current endpoint selects the latest timestamp, but an admin can review any pending document and unconditionally overwrite the worker's status. Submitting A, then B, then approving A can make the worker VERIFIED while B is still the current pending document. Reviewing B later changes the status again. Equal submission timestamps also make the current selection ambiguous.

Fix: explicitly identify the current submission, preserve older submissions as history, and reject reviews of superseded documents. Lock the worker while submitting/reviewing. Enforce valid document states and review metadata: a submitted document cannot be NOT_SUBMITTED, rejection requires a reason, and reviewed states require a review timestamp. Account for staging auto-approval when deciding whether `reviewed_by` can be null.

### 2. Worker category and type relationships are only partly enforced

Evidence: [schema.sql:141](../../database/schema.sql#L141), [schema.sql:173](../../database/schema.sql#L173), `worker.service.js` (`validDraft`).

The database allows a worker in one category to have types from another, no types at all, negative positions, or no position zero. It also permits a CUSTOMER account to own a worker profile. API validation handles several of these cases, but imports, administrative SQL, and later changes to catalog categories can bypass it.

Fix: enforce category/type consistency with composite relationships or a constraint trigger. Add `position >= 0`. Enforce the required primary type at transaction completion because a profile update temporarily deletes its type rows. Decide whether account roles are exclusive before enforcing the worker-owner role in SQL. Keep caller authorization in the API.

### 3. Discounts can become invalid after a price edit

Evidence: [schema.sql:204](../../database/schema.sql#L204), `worker.service.js` (`setDiscount`, `update`), `worker.repository.js` (`search`, `update`, `setDiscount`).

The fixed discount check runs when setting a discount, outside a shared transaction with the price read. Editing the worker's price does not revalidate the discount. Example: starting price 50, discount 20, then starting price changed to 10; PRICE sorting calculates -10. A fixed discount is also accepted when there is no starting price.

Fix: define whether discounts require a starting price; validate both discount changes and price changes while locking the same worker row. Prefer enforcing the invariant across both tables as well. Define currency and price-unit comparison rules: the current API accepts different currencies and units but sorts their numeric amounts together.

### 4. OTP replacement reuses the challenge identity

Evidence: [schema.sql:46](../../database/schema.sql#L46), `auth.repository.js` (`saveOtp`, `consumeOtp`, `incrementOtpAttempts`), `auth.service.js` (`sendOtp`, `verifyOtp`).

The upsert replaces a code but keeps its row ID. Verification reads the hash first, then consumes by ID and general expiry/attempt conditions. If a resend replaces the code between those operations, verification against the old code can consume the replacement challenge. Concurrent sends also check the resend interval before the upsert, so the interval is not atomically enforced. These are concurrency risks, not reproduced failures.

Fix: give each issuance an immutable challenge ID/version, and condition consumption and attempt updates on that issuance. Atomically enforce resend timing. Add local checks for nonnegative attempts and sensible expiry/resend ordering. Bind hashes to challenge context as well as the code. The global `(purpose, destination)` key also means two accounts requesting the same destination can replace each other's challenges; document or revise that policy.

### 5. Search maintenance is missing

Evidence: [schema.sql:163](../../database/schema.sql#L163), `worker.repository.js` (`create`, `update`, `search`), `prisma/seed.js`.

The schema declares a search vector and GIN index and says the app or a trigger refreshes it. Neither normal profile creation nor editing refreshes it. Seed data populates a vector, which can conceal the gap during manual development. Other ILIKE clauses still find matches, so this does not mean all search is broken. RELEVANCE currently orders by rating rather than a relevance score, and worker-type translation matching is restricted to English.

Fix: choose a single maintenance mechanism covering worker details, services, types, keywords, and translations. Backfill existing rows. Define multilingual matching and relevance ranking explicitly.

### 6. Push delivery has no durable retry record

Evidence: [schema.sql:278](../../database/schema.sql#L278), `src/jobs/reminder.repository.js`, `notification.service.js`, notification-producing services.

Notifications are persisted, but pushes happen after the business transaction commits. The reminder job marks rows sent before attempting FCM delivery. A crash in between loses the push, and delivery failures are logged without a retry record. The in-app notification remains available.

Fix: write a delivery/outbox record in the business transaction, then retry delivery with bounded backoff and per-device outcomes. Define `sent_at` as a specific milestone, such as notification creation or provider acceptance. External delivery can be duplicated, so use notification IDs for client deduplication.

### 7. Review aggregates need stronger maintenance guarantees

Evidence: [schema.sql:305](../../database/schema.sql#L305), `interactions.repository.js` (`saveReview`), `interactions.service.js` (`addReview`).

The trigger recomputes the average/count but does not explicitly serialize review writers before aggregate calculation. Concurrent review writes need verification under the deployed isolation level. There is also a definite structural gap: changing `worker_id` alone does not fire this trigger; changing `worker_id` and rating refreshes only the new worker, leaving the old worker's aggregate stale.

Fix: make review ownership immutable or refresh both affected workers. Serialize writes per worker before modifying reviews, or use a carefully designed aggregate update. Preserve the existing one-review-per-user/worker uniqueness rule. Reconcile existing aggregates when introducing the fix.

### 8. Soft deletion and session lifetime lack a defined policy

Evidence: [schema.sql:27](../../database/schema.sql#L27), [schema.sql:60](../../database/schema.sql#L60), `auth.repository.js`, `worker.repository.js`, `src/middlewares/auth.js`.

Auth lookups exclude deleted users, while phone/email uniqueness still reserves their identifiers. Worker listing queries do not check whether the owning user is deleted. Access-token authorization trusts JWT claims until expiry without checking deletion, role changes, or admin removal. Refresh tokens are revoked on recovery/phone change, but existing access tokens remain usable for their remaining lifetime. There is no account-deletion endpoint in the supplied contract.

Fix: define identifier reuse, worker visibility, retention/anonymization, and whether access revocation must be immediate. Add a session/token version or server-side session check if immediate revocation is required. Refresh token lineage exists through `replaced_by`, but there is no independent session/family identity; the function named `revokeTokenFamily` currently revokes every active refresh token for the user.

## Further schema gaps

| Area | Finding | Proposed treatment |
| --- | --- | --- |
| Shared profile fields | `users` and `workers` both contain name/avatar/phone. Account edits sync name/avatar to workers, but worker edits do not sync back. | Decide whether these are account fields or separate business-profile fields, then document and enforce the direction of synchronization. |
| Cross-table integrity | SQL allows a message sender outside the conversation, self-conversations/requests/reviews, and reminders addressed to nonparticipants. Current services implement several of these checks. | Decide which relationships must also be protected in SQL; use suitable relationships/triggers rather than assuming ordinary foreign keys validate participation. |
| Untyped references | Notifications, history, and reminders use free-text `reference_id`, allowing dangling or incorrectly typed links. | Use typed nullable foreign keys and exclusivity checks, or an explicit target discriminator with a documented validation/deletion policy. |
| Working hours | One interval per weekday and `closes_at > opens_at` exclude split shifts and overnight work; no schedule timezone is stored. | Confirm required scheduling behavior. If expanded, model intervals and an explicit timezone rather than weakening the existing check alone. |
| Local validation | Worker names/services can be blank in SQL; worker phone fields lack the users-table phone check; currency accepts arbitrary three-character values. Banner language and start/end order are unchecked. | Add inexpensive local constraints consistent with the agreed API. Avoid time-dependent CHECK constraints such as expiry > now(). |
| Settings | `user_settings.updated_at` has no touch trigger; API upserts maintain it explicitly. Missing settings rows fall back to defaults. | Choose whether API defaults are intentional, and use one consistent timestamp maintenance policy. |
| Upload lifecycle | Private storage has user-prefixed keys and existence checks, but there is no upload metadata table, attachment lifecycle, or abandoned-upload cleanup record. | Add ownership, media metadata, attachment state, and cleanup/retention tracking if those lifecycle guarantees are required. |
| Catalog | Standalone SQL seeds English translations only. The separate JS seed supplies more translations. No rule ensures active items have a fallback name; active types can belong to inactive categories. | Define translation fallback and catalog deactivation rules, and keep deployment seed paths consistent. |
| Deletion | Many operational records cascade from users/workers; some references, such as message sender and document reviewer, restrict deletion. | Define retention before changing these actions; neither blanket cascading nor blanket soft deletion is a complete policy. |
| Indexing | Some referencing columns lack an index beginning with that column, such as history worker and reminder recipient. Geo filtering currently calculates distance rather than using a spatial index. | Add indexes driven by deletion and query patterns. Consider PostGIS only when scale and measured plans justify it. |

## API contradictions and missing decisions

1. **Registration and verification:** `DOCUMENT_REQUIRED` says worker registration requires an identity document, but W5 has no document field and V1 requires an existing worker. The implementation creates PENDING workers without a document. A coherent proposed sequence is create NOT_SUBMITTED worker, upload/attach document, move to PENDING, then review; confirm Android expectations before changing the response.
2. **Roles:** a single CUSTOMER/WORKER enum prevents a worker from using endpoints restricted to customers. Decide whether workers can hire and review other workers, and whether users can switch roles. Adding ADMIN to that enum alone would not solve this; administration already uses a separate flag.
3. **Pagination:** the global convention specifies `{items,nextCursor}`, but most endpoint tables specify bare arrays. Notifications and history in the implementation have hard limits with no continuation. Choose the response shape per endpoint and document it consistently.
4. **Message cursors:** `before=<sentAt>` cannot page safely through messages sharing a timestamp. Use an opaque cursor containing timestamp plus ID, with matching deterministic ordering and an index.
5. **Notification routing:** SERVICE_REQUEST_UPDATED points to a worker for customer notifications, while cancellation uses that same type with a request ID for the worker. Type plus reference ID is insufficient to identify the target kind consistently. Add an explicit target or a complete recipient-aware routing contract.
6. **Review eligibility:** the current contract allows any customer to review a verified worker, without a completed request. This is a product choice, not a missing constraint by itself. If reviews must represent completed work, add a request relationship and an eligibility rule.
7. **Request history:** no transition actor, reason, timestamps per transition, or event history is stored. Add a history table if support/audit requirements need to explain how a request reached its current state.
8. **Retries:** non-idempotent writes such as creating requests and sending messages have no client request key. Decide on idempotency keys so mobile retries do not create duplicate actions and notifications.
9. **Errors:** INVALID_TRANSITION is used later but absent from the central error list, and its example omits the standard `error` wrapper. The implementation also emits codes such as INVALID_REQUEST and STORAGE_UNAVAILABLE outside that list. Reconcile the server and Android error vocabulary.
10. **Admin API:** the verification list advertises a status filter, but the implementation fetches pending documents only. Document the actual supported filter and pagination behavior.
11. **Localization:** catalog reads use a language fallback, but several notification producers hardcode English. Decide whether stored notifications use the recipient's saved language; an initiating request's Accept-Language can belong to the other participant.

## Prisma and migration ownership

`prisma/schema.prisma` models only seven tables. It omits most application tables, Worker starting-price fields, SQL relationships, and indexes. Many repositories intentionally use raw SQL for those objects. The committed SQL migration contains them, so missing Prisma models do not mean the deployed tables are absent. However, the Prisma model is not currently a complete representation from which future schema migrations can safely be inferred without review.

Choose a complete Prisma model with explicit SQL support for features it cannot represent, or establish SQL migrations as the deliberate source of truth and clearly document Prisma's limited role. Keep `schema.sql` as a synchronized bootstrap/reference artifact. If the initial migration has already been applied, introduce forward migrations rather than rewriting applied history.

## Suggested implementation order

1. Settle role capabilities, verification sequence, shared profile fields, pricing/currency rules, and deletion/session policy.
2. Add forward schema migrations for verification identity, relational integrity, local checks, and the agreed lifecycle fields; identify invalid existing rows before enforcing constraints.
3. Update the affected services together with OTP issuance, discount locking, review maintenance, and search refresh.
4. Add durable delivery tracking and consistent pagination/routing.
5. Align API.md, OpenAPI, Prisma, bootstrap SQL, seeds, and Postman with the resulting contract.

Concurrency fixes should receive targeted runtime verification during implementation; this investigation establishes candidates and code paths, not proof from executed workloads.

PostgreSQL references: [constraint scope and foreign keys](https://www.postgresql.org/docs/15/ddl-constraints.html), [Read Committed snapshots and concurrent updates](https://www.postgresql.org/docs/15/transaction-iso.html). Cross-table invariants need a mechanism beyond ordinary row CHECK constraints, and transactions need an explicit concurrency strategy for read-then-write decisions.
