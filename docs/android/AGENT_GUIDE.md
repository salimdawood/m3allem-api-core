# Instructions for the Android coding agent

This is a backend handoff package, not the Android repository. Integrate with the
existing Android architecture and libraries; do not replace working app structure.
Read README.md first, then api/openapi.yaml and docs/API.md for exact endpoint fields.
Read docs/FILES_AND_STORAGE.md before implementing images or document previews.

## Sources of truth

- Deployed test origin: {{API_ORIGIN}}. App requests use /v1; health uses root /health/*.
- api/openapi.yaml and docs/API.md define the supported HTTP contract. Response
  examples are illustrative; resolve actual IDs from API responses/environment.json.
- database/schema.sql defines domain constraints and retained resource lifecycles.
  It is reference material; do not execute bootstrap/reset/seed commands remotely.
- verification.json distinguishes successful remote checks from unverified journeys.
- The private Postman environment is a QA convenience; never copy its tokens into
  application code, logs, screenshots, committed configuration or generated examples.

## Required client behavior

1. Use numeric Kotlin Long IDs, message numbers and versions. JSON IDs must be
   unquoted integers, not UUIDs or strings. OTP codes remain six-character strings.
2. Responses are direct objects/arrays, not a universal data envelope. 204/304 have
   no body. Most dates are epoch milliseconds; inbox/history dates are ISO strings.
3. An account may both hire and own one worker profile. isWorker is a capability;
   isAdmin is separate. Never assume mutually exclusive CUSTOMER/WORKER roles.
4. Login requires the exact challengeId. Registration accepts a single-use proof;
   upload endpoints require an existing account's access token. Persist rotated
   access/refresh pairs atomically and serialize refresh with one in-flight operation.
5. Do not auto-replay arbitrary writes after a timeout/5xx. A write might have
   committed. Reconcile HTTP state before creating duplicate requests/messages/uploads.
6. Show public images by resolving profileImageUploadId through GET /uploads/{id};
   the profile DTO does not contain a permanent avatar URL. A null ID means placeholder.
   Upload once, then attach the returned ID with PATCH /me. Never use bucket keys as IDs.
7. Identity files stay private. Owners resolve upload access; admins use the pending
   review document endpoint. Signed links expire in 300 seconds and should be renewed.
8. Treat cursors as opaque, account/filter-bound values. On request status 409,
   refetch version and reconcile. Worker profile PUT replaces editable child lists:
   preserve existing child IDs to keep identity.
9. Realtime is an authenticated server event stream over WebSocket, not the chat
   write API. Use HTTP to send messages. Refetch state after reconnect; no replay/ack
   protocol exists. Never append access tokens to the WebSocket URL.
10. Deduplicate push by notificationId. Firebase data values are strings; HTTP IDs
    are numbers. Current test delivery may be mocked/disabled; do not infer handset
    delivery from inbox availability or successful device registration.

## Suggested implementation order

Configure origin and DTO types -> auth/session storage -> catalog and worker
discovery/detail -> own profile/avatar -> worker onboarding/identity -> chat ->
request transitions and reviews -> settings/favorites/inbox -> realtime and push.
Use docs/TEST_JOURNEYS.md as the acceptance checklist and Postman as a reference.
Keep any UI text and app-specific decisions consistent with the existing Android app.

Report backend gaps with exact endpoint, request body without tokens, response code,
error.code and requestId. Do not invent unsupported endpoints or client-side admin grants.
