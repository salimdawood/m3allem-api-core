# Database files

- `schema.sql`: authoritative bootstrap for an empty database; includes constraints, triggers and catalog seeds.
- `deployment/preflight.sql`: read-only existing-database inspection.
- `deployment/seed.env.example`: configuration template for a deliberately selected fresh seed database.
- `validation/`: repeatable SQL validation runner, fixtures and recorded results.
- `archive/initial-uuid-schema.sql`: historical reference only; never apply to the current numeric-ID database.

Use `npm run db:preflight` and `npm run db:migrate` from the repository root. Prisma is used only for model mappings and client generation; there is no active Prisma migration directory or reset command. Read [deployment instructions](../docs/DEPLOYMENT.md) before schema changes.
