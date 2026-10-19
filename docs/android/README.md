# M3allem Android developer handoff

Start here. This package describes the current numeric-ID backend for the Android app.
Read `AGENTS.md` when using a coding agent, then `docs/ANDROID_INTEGRATION.md`,
`docs/FILES_AND_STORAGE.md`, and `docs/TEST_JOURNEYS.md`.

## Connect

| Purpose | URL |
| --- | --- |
| API origin / Postman rootUrl | {{API_ORIGIN}} |
| App API base | {{API_ORIGIN}}/v1 |
| Retrofit base URL (trailing slash required) | {{API_ORIGIN}}/v1/ |
| Catalog, public | {{API_ORIGIN}}/v1/catalog |
| Database readiness | {{API_ORIGIN}}/health/ready |
| Process liveness | {{API_ORIGIN}}/health/live |
| Authenticated realtime | {{WS_URL}} |
| Public profile files, prefix only | {{PUBLIC_PROFILE_BASE}}/ |

`/catalog` returns 404; `/v1/catalog` is correct. Bucket prefixes are not browseable
image links. The app should consume URLs returned by `/v1/uploads/{id}` or upload
responses; private documents need a signed URL. See the storage guide.

## Use Postman immediately

1. Import `postman/M3allem_API.postman_collection.json`.
2. Import and select `postman/M3allem_Render_Authenticated.private.postman_environment.json`.
3. Try Health, Catalog, Account -> Read private current account, and worker search/detail.
4. Tokens are real test credentials, including admin QA access. Do not embed them
   in the app or distribute this private ZIP publicly. Access JWTs expire after
   15 minutes: use Sessions -> the matching actor -> Refresh before testing further.
5. After refresh-token expiry/revocation, run that actor's Send OTP then Verify
   account login requests. Current staging OTP is the string `111111`; wait at
   least 30 seconds between sends to the same phone. A fresh user must register.

The collection saves captured values into the selected environment. Refresh rotates
the pair; never retry an old refresh token. Do not Run All: registration alternatives,
refresh/logout, approve/reject and destructive lifecycle operations conflict.

The shared `M3allem_API_Server.postman_environment.json` has URLs only and can be
used without distributing the private token environment.

## Package map

- `api/openapi.yaml`: all 84 HTTP operations, request/response schemas and auth.
- `api/response-schemas.json`: response DTO schemas as JSON Schema definitions.
- `docs/API.md`: full field and lifecycle reference.
- `docs/ANDROID_INTEGRATION.md`: Android types, auth, pagination, errors, realtime and push.
- `docs/FILES_AND_STORAGE.md`: Neon bucket URLs and the avatar/private-document flows.
- `docs/TEST_JOURNEYS.md`: ordered acceptance scenarios and current limitations.
- `database/schema.sql`: authoritative numeric-ID SQL bootstrap, for reference.
- `database/schema.prisma`: ORM mappings; SQL owns constraints, triggers and views.
- `database/SCHEMA_GUIDE.md`: database/entity overview and rules for client mapping.
- `examples/`: synthetic avatar/PDF fixtures and illustrative Kotlin snippets.
- `environment.json`: non-secret URLs, capabilities and account/worker IDs.
- `verification.json`: timestamped checks actually performed against the deployed API.
- `MANIFEST.json`: file sizes and SHA-256 hashes, including private environment content.

The app accesses the API and returned object URLs. It does not connect to Postgres
or use S3 credentials. The supplied SQL is not an instruction to reset a database.
This bundle contains neither a database dump nor backend secrets.
