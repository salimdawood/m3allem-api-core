# Render test deployment

The API runs on Render. PostgreSQL and uploaded objects stay on Neon. The
`src/modules/uploads/` directory is application code and must be committed;
it does not store user files. Multer buffers uploads in memory, then the S3
client writes them to the configured Neon bucket. Only root `/uploads/` is ignored.

Commit all seven source files in `src/modules/uploads/`, plus the deployment
configuration changes, then push to Render's linked branch.

| Setting | Value |
| --- | --- |
| Root directory | Repository root (leave blank) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Node version | `24` (matches local validation; `.node-version` and engines are bounded to 24) |
| Health check | `/health/ready` |

If a Render `NODE_VERSION` variable is set, set it to `24` too; it takes priority
over `.node-version`. Do not run `npm run dev` or `node --watch` on the service.
The build verifies runtime imports and generates Prisma Client for Linux.

For the current mock test environment, explicitly set `NODE_ENV=development`,
`APP_ENV=staging`, `DELIVERY_MODE=mock`, `OTP_FIXED_CODE=111111` and
`PUSH_DELIVERY_ENABLED=false`. Provide database, JWT/OTP secrets and Neon S3
configuration through Render environment variables, including `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_PROFILE_BUCKET`,
`S3_IDENTITY_BUCKET` and `S3_PUBLIC_BASE_URL`. The existing buckets are
`seed-public-profiles` and `seed-private-identities` on `production`.

Use Render's provided `PORT`. Do not bootstrap/reset the existing seeded database
as part of deployment. Set the Postman API Server environment's `rootUrl` to the
resulting HTTPS API origin.

References: [Render Express deployment](https://render.com/docs/deploy-node-express-app)
and [Node version selection](https://render.com/docs/node-version).
