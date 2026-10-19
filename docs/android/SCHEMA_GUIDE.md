# Current database schema: client-facing meaning

`database/schema.sql` is the authoritative current numeric-ID schema; `schema.prisma`
contains its ORM mappings. The API is the Android contract. Do not expose database
connections to the app or generate mobile SQL against the production branch.
This package includes schema-only source, no row dump or connection password.

The active Neon branch is `production`, database `neondb`, PostgreSQL 18. There are
29 application tables with numeric identities/keys and retained soft-deletion metadata.
The old UUID schema/migration is deliberately excluded from this handoff.

| Domain | Tables / responsibility |
| --- | --- |
| Accounts | users, user_settings, devices |
| Auth | otp_flows, otp_challenges, auth_sessions, refresh_tokens |
| Catalog | categories, category_translations, worker_types, worker_type_translations, promo_banners |
| Workers | worker_profiles, worker_worker_types, worker_services, worker_working_hours, worker_discounts |
| Files / verification | file_uploads, identity_documents |
| Chat | conversations, messages |
| Requests / reputation | service_requests, service_request_events, reviews |
| Activity | favorites, contact_history, notifications |
| Delivery | notification_deliveries, scheduled_reminders |

Use `database/schema.sql` for exact names and fields; the table list in environment.json
is extracted from that SQL. Domain rules are enforced by SQL checks, triggers, partial
indexes, exclusions and deferred foreign keys; Prisma alone cannot recreate them.

## Client mapping rules

- JSON entities use camelCase; SQL columns are snake_case. Implement DTOs against the API,
  not raw table rows. Internal secret hashes, storage keys and tombstones are not mobile fields.
- BIGINT identities map to numeric JSON and Kotlin Long, bounded by Number.MAX_SAFE_INTEGER.
- Rows have soft deletion; IDs and historical references remain stable and identifiers
  such as phone/email may remain reserved. Account deletion cannot be restored via the API.
- One user may own a worker profile and hire other workers. isAdmin is independent.
- An upload's numeric ID is distinct from its private/public object key. Account avatar
  references use profileImageUploadId; worker name/avatar come from the owning account.
- The latest live identity submission is current. Older approval does not become current
  when a newer submission is removed/rejected. Review outcomes cannot be edited in place.
- Conversations retain original customer/worker participants; request events retain
  original actors and versions. A version is required for a status transition.
- Reviews require a genuine completed request by that customer. Do not invent proof IDs
  for migrated client rows or attempt to submit a rating without a completed request.
- Notifications use typed requestId/conversationId/workerId targets; ignore null targets.
  Device delivery is separate from inbox availability and is at least once.

The SQL source can bootstrap an empty database for backend-owned development only.
Never run it against the existing seeded branch. Android implementation requires no
schema execution, Prisma setup, Neon credentials or AWS keys.
