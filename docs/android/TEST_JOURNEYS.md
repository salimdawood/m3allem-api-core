# Test journeys and known boundaries

Start with the private Render Postman environment. See `environment.json` for actual
account/worker IDs and `verification.json` for checks completed when this ZIP was built.
Request examples in the collection contain synthetic DTOs; they are not fresh credentials.

## Existing seed accounts

| Actor | Phone | Use |
| --- | --- | --- |
| Customer | +96170000001 | Search workers, initiate chat/requests, review completed work |
| Worker | +96170000002 | Own worker profile, accept/complete requests, submit identity |
| Admin QA | +96170000003 | Current pending verification and account moderation, only if testing admin UI |

Current staging login code: `111111`. Seed phone numbers are synthetic fixtures;
do not test real SMS sending to them. Registration does not assign a role or grant admin.

## Acceptance sequence

1. GET root `/health/live`, `/health/ready`; GET `/v1/catalog` with en/fr/ar preferences.
2. Login each selected account using Send OTP -> Verify exact challenge. Read `/v1/auth/me`.
3. Search/list/detail workers as customer; read `/v1/me/worker` as worker. Verify public
   profile visibility, prices, localized catalog IDs and null avatar placeholders.
4. Upload `examples/sample-avatar.png` using the selected account; attach numeric ID
   with PATCH me; read profile, resolve metadata and load the returned public image URL.
5. For an onboarding test, use a new phone/account, create a worker profile using catalog
   IDs, upload `examples/synthetic-identity.pdf`, then submit identity. As a separate
   admin, preview the current pending document and approve OR reject. A new submission
   supersedes previous decisions; public discovery requires current verification.
6. Customer starts/reuses a conversation with the target worker, sends a text over HTTP;
   worker reads and replies. Check pagination and realtime notification/refetch behavior.
7. Run Request completion journey: customer creates -> worker accepts latest version ->
   worker completes next version -> customer reviews with that completed request ID.
   Creating a new request does not require a fabricated request/version. A 409 means refetch.
8. Read settings, favorites, inbox and history. Mark notification read. Register an actual
   device if exercising push separately; mock/disabled push does not test the handset.
9. Exercise refresh once, verify rotated pair, then logout. Keep this separate from other
   journeys; auth changes and moderation deliberately revoke sessions.

Do not run lifecycle/delete/moderation requests against the shared customer, worker or
admin accounts unless intentionally testing those transitions. Use fresh dedicated
accounts/resources for destructive cases; the seed has no automatic reset workflow.

## Current limits

- No Android client source is included; Android flows still need validation in that app.
- Live checks are recorded individually. The bundle build does not modify profiles,
  create chat/messages/requests/reviews, approve identity or test new object writes.
- Public profile bucket was empty at inspection. Private seed PDFs are accessible only
  through authorized signed URLs. Image display must support null/unfinished uploads.
- Real SMS/email/Firebase delivery is not established by staging OTP/inbox tests.
- Realtime is process-local; the first deployment should use one API instance. Clients
  must reconnect/refetch after process restarts. No typing/receipt/presence endpoint exists.
- Inbox returns latest 200 records, contact history 250 and favorite expansion 200, with
  no continuation for older records in those endpoints. Other pagination is documented.
- Upload reconciliation/purge is manual; PDF inspection is a signature check, not malware scanning.
- Server readiness tests database connectivity. Use verification timestamps to assess
  freshness; they do not guarantee future service/provider availability.

## Reporting a problem

Send the method, full path (without bearer or signed query parameters), request body
without credentials, HTTP code, error.code, requestId, app version and expected behavior.
401/403/404/409 are distinct. Never share access/refresh tokens or private identity files
in issue screenshots/logs. All exact payload fields and limits are in docs/API.md.
