# Code readiness — October 19, 2026

The backend has implemented routes for authentication/accounts, catalog, worker
profiles/search, uploads/verification, conversations/messages, service requests,
reviews, notifications/devices, realtime events and reminder/push jobs. No missing
route group was identified against the current documented backend contract.
Android integration and real provider operation remain unverified.

## Verified locally

- All 107 existing tests passed against fresh, isolated local PostgreSQL databases
  or mocked delivery providers. The application database was not used by those tests.
- Two new runtime regression tests passed: Redis commands during connection startup,
  and late controller failures after a request timeout.
- `npm run docs:check` passed: 84 HTTP routes, 47 response schemas and 99 Postman requests.
- Fixed Redis startup commands being rejected by its disabled offline queue. Queued
  commands now have five-second command and connection limits, with bounded retries.
- Fixed the error handler attempting another response after timeout headers had
  already been sent; it now delegates to the next error handler.
- Added `npm test` for all suites and `npm run test:runtime` for the two new checks.

## Remaining for an Android test release

1. **Client reconciliation.** The Android source is absent here. Validate numeric
   IDs, OTP challenge IDs, token refresh/reuse, worker capability, request versions,
   upload IDs and deletion/restoration against the API. Reconnect realtime with a
   fresh access token and deduplicate pushes by notification ID. Follow the
   [Postman journeys](../postman/README.md) for complete account/worker/request flows.
2. **Hosted API.** Hosting is undecided. Start with one persistent Node process
   supporting HTTPS, WebSocket upgrades and recurring timers. Realtime's client map
   is process-local; multiple instances need shared event distribution. Use
   `/health/ready` for readiness, `/health/live` for liveness, and allow graceful
   shutdown up to `SHUTDOWN_TIMEOUT_MS`. Generate Prisma Client on the target OS.
3. **Test environment.** Keep mock testing explicitly configured with
   `NODE_ENV=development`, `APP_ENV=staging`, `DELIVERY_MODE=mock`,
   `OTP_FIXED_CODE=111111`, and `PUSH_DELIVERY_ENABLED=false`. Current validation
   deliberately rejects mock delivery with `NODE_ENV=production`; hosts that set
   that automatically need an explicit test override. Set `TRUST_PROXY_HOPS` for
   the actual host's proxy topology. CORS origins are needed for browser clients.
4. **Database selection.** Use `production` as the single active Neon branch with
   database `neondb` and its profile/identity buckets, containing the previously
   authorized synthetic seed. Local configuration and default seed verification/
   storage import commands select this branch. The older development branch was
   deleted on October 19, 2026. SQL owns the schema:
   use preflight for existing databases and bootstrap only for an empty database.
   Do not run Prisma migrations/db push or reset the current dataset to deploy code.
5. **Storage journey.** Storage endpoint, bucket names, public URL and explicit AWS
   credentials are present locally; their presence does not prove provider access.
   Test a new avatar upload/display and identity upload/admin review from the hosted
   API. Integration suites substitute storage. Previous seeded download checks are
   documented in [the reset report](archive/PRODUCTION_RESET.md).

## Remaining before real delivery / production

- Configure and verify SMS delivery permissions, SES sender, Firebase project and
  credentials. The active configuration uses mocks, has push disabled, and has no
  explicit SES sender or Firebase settings. Fixed staging OTP skips real delivery
  in live mode; a real OTP journey needs a non-staging environment with no fixed code.
- Configure Redis and verify real rate-limit script execution/outage behavior.
  Production requires Redis. The new runtime test uses a local RESP peer to verify
  connection startup; it does not replace a deployed Redis integration check.
- Use live delivery, random secrets and production environment settings. Confirm
  trusted proxy settings, HTTPS, public avatar access and private identity policies.
- Exercise real client/provider journeys and measure search/edit latency with the
  seeded volume. Local integration tests do not establish deployment performance.
- Add source control and host-specific build/deploy automation. This workspace has
  no Git repository, CI configuration or application hosting configuration.

## Existing limits to decide later

- Notifications return at most 200 records and contact history at most 250 without
  a continuation cursor. Favorite worker expansion returns at most 200. Older
  records need pagination if the app must expose the complete retained history.
- Upload reconciliation/purge is manual; a crash can leave pending records or
  retained unreferenced objects. PDF inspection is a signature check, not scanning.
- Timestamp representations differ across some HTTP/realtime DTOs, as documented
  in [API.md](API.md).
- Integration tests require the dedicated local PostgreSQL instance on port 55436
  and currently set a Windows Prisma engine path. Linux CI needs that test setup
  adapted. Provider/runtime tests and contract checks do not need this database.

No API deployment, live database change or real provider send was performed during
this review. The existing local test PostgreSQL instance was started for validation.
