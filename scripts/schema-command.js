import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { postgresEnvironment } from './postgres-environment.js';

const files = { bootstrap: 'schema.sql', preflight: 'deployment/preflight.sql' };
const command = process.argv[2];
if (!files[command]) throw new Error('Use bootstrap or preflight.');
const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');
const file = fileURLToPath(new URL(`../database/${files[command]}`, import.meta.url));
const result = spawnSync(process.env.PSQL_BIN || 'psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', file], {
  env: postgresEnvironment(connection), stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
