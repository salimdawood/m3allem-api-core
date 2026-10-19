# Repository cleanup — October 19, 2026

Removed unused direct dependencies `argon2` and `@neon/env` after checking imports across source, scripts, tests and configuration. npm removed 20 installed packages including their unused dependencies. `@neon/config` remains because `neon.ts` imports it; it is now a development dependency.

Removed unreachable `src/utils/cursor.js` (the retired offset cursor), the unused `auth-or-registration.js` compatibility alias, the obsolete `prisma/seed.js` shim, and retired reset scripts (`reset-db.js`, `legacy-db-command.js`, `reset-production.js`). The `db:reset` package command was removed. Current pagination uses the worker keyset cursor and shared `page-cursor.js`.

Moved the long mixed schema folder into `database/`, moved maintained guides into `docs/`, and historical alignment/review/reset reports into `docs/archive/`. Archived the initial UUID SQL under `database/archive/`, outside Prisma migration discovery. Updated commands, generators, tests and document links. Seed verification/storage scripts now reject the deleted development branch.

Retired environment files are preserved in ignored `.archive/environments/`. One-off local schema editing/introspection helpers are preserved in `.archive/schema-tools/`. Neither directory is application code. The active `.env`, local PostgreSQL cluster, seed manifests/PDFs, reset evidence and validation results remain intact. No remote database or storage contents were changed.

Retained intentional artifacts: generated API/OpenAPI/Postman files are the developer handoff; `scripts/development-seed*.sql` are used by the guarded fresh-database seed; `neon.ts`, `.neon`, `.agents/` and `skills-lock.json` are local infrastructure/tooling configuration. The README identifies active directories and ignored local state.

Validation after cleanup: all 109 Node tests, all 51 SQL schema tests and the API/Postman contract checks passed. Local import/link checks found no missing references, unused direct runtime dependencies or unreferenced application source files. npm reports a consistent dependency tree.
