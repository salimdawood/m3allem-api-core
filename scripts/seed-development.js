import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { postgresEnvironment } from './postgres-environment.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[i + 1];
};
const allowed = new Set(['--env-file', '--size', '--bootstrap', '--output', '--help']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}`);
  if (!['--bootstrap', '--help'].includes(args[i])) i++;
}
if (args.includes('--help')) {
  console.log('Usage: npm run db:seed -- --env-file <seed-env-file> [--size large|small] [--bootstrap] [--output .seed-data]');
  console.log('Uses SEED_DATABASE_URL and exact SEED_EXPECTED_HOST/SEED_EXPECTED_DATABASE from the explicit seed env file. No production DATABASE_URL fallback.');
  process.exit(0);
}
const explicitEnvFile = option('--env-file');
if (!explicitEnvFile) throw new Error('Seeding is not part of the single-branch workflow. An explicit --env-file is required for a separate empty seed database.');
const envFile = resolve(root, explicitEnvFile);
const env = parse(await readFile(envFile));
if (env.APP_ENV !== 'staging') throw new Error('The seed environment must explicitly set APP_ENV=staging.');
if (env.PUSH_DELIVERY_ENABLED !== 'false') throw new Error('The seed environment must explicitly disable push.');
if (!env.SEED_DATABASE_URL || !env.SEED_EXPECTED_HOST || !env.SEED_EXPECTED_DATABASE) throw new Error('Explicit seed connection and expected host/database are required.');
const connection = new URL(env.SEED_DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(connection.protocol) || connection.hostname !== env.SEED_EXPECTED_HOST ||
  decodeURIComponent(connection.pathname.slice(1)) !== env.SEED_EXPECTED_DATABASE || !/^m3allem_seed_[a-z0-9_]+$/.test(env.SEED_EXPECTED_DATABASE))
  throw new Error('Seed connection does not match the explicitly named seed database.');
if (connection.hostname.includes('-pooler.')) throw new Error('Use a direct connection for schema and seed operations.');
const presets = { small: { users: 100, workers: 20, requests: 200, messages: 1000 }, large: { users: 5000, workers: 500, requests: 10000, messages: 50000 } };
const size = option('--size', 'large'), counts = presets[size];
if (!counts) throw new Error('Size must be small or large.');
const output = resolve(root, option('--output', '.seed-data'));
if (!output.startsWith(`${root.replace(/[\\/]$/, '')}\\`) && !output.startsWith(`${root.replace(/[\\/]$/, '')}/`)) throw new Error('Seed artifacts must be inside this workspace.');
await mkdir(output, { recursive: true });
const schema = await readFile(new URL('../database/schema.sql', import.meta.url));
const schemaHash = createHash('sha256').update(schema).digest('hex');
const log = [];
function psql(args, { capture = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(env.PSQL_BIN || 'psql', ['-X', '-v', 'ON_ERROR_STOP=1', ...args], {
      cwd: root, env: { ...postgresEnvironment(env.SEED_DATABASE_URL), PGAPPNAME: 'm3allem-development-seed' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const sanitize = (value) => value.replaceAll(env.SEED_DATABASE_URL, '[seed connection]').replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[connection]');
    child.stdout.on('data', (chunk) => { const text = sanitize(chunk.toString()); stdout += text; if (!capture) process.stdout.write(text); });
    child.stderr.on('data', (chunk) => { const text = sanitize(chunk.toString()); stderr += text; if (!capture) process.stderr.write(text); });
    child.on('error', (error) => reject(new Error(`Could not launch psql (${error.code ?? 'UNKNOWN'}). Set PSQL_BIN in the seed env file.`)));
    child.on('close', (code) => {
      log.push(stdout, stderr);
      if (code !== 0) return reject(new Error(`psql failed (exit ${code}). ${capture ? stderr : 'See seed log; no partial seed transaction is committed.'}`));
      done(stdout.trim());
    });
  });
}

// A real, deliberately marked synthetic PDF. Files stay local unless explicitly
// imported into development object storage; no external provider writes occur.
const stream = 'BT /F1 16 Tf 40 120 Td (SYNTHETIC DEVELOPMENT SAMPLE) Tj 0 -24 Td (NOT A VALID IDENTITY DOCUMENT) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
];
let pdf = '%PDF-1.4\n', offsets = [0];
for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const bytes = Buffer.from(pdf), pdfHash = createHash('sha256').update(bytes).digest('hex');
const manifest = { version: 1, size, counts, projectId: env.SEED_NEON_PROJECT_ID, branchId: env.SEED_NEON_BRANCH_ID,
  branchName: env.SEED_NEON_BRANCH_NAME, database: env.SEED_EXPECTED_DATABASE, host: env.SEED_EXPECTED_HOST,
  schemaSha256: schemaHash, assets: [], storageState: 'LOCAL_FIXTURES_ONLY_NOT_UPLOADED',
  security: 'No pre-issued OTPs, JWTs, sessions or refresh tokens. Authenticate through staging OTP endpoints.',
  push: 'Synthetic devices and deliveries retained as retired rows; no provider sends or fake acceptance.',
  accounts: { customer: { phoneNumber: '+96170000001' }, worker: { phoneNumber: '+96170000002' }, admin: { phoneNumber: '+96170000003' } } };

try {
  console.log(`Development seed target: ${env.SEED_EXPECTED_HOST}/${env.SEED_EXPECTED_DATABASE}; preset ${size}.`);
  const occupied = await psql(['-At', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], { capture: true });
  if (args.includes('--bootstrap')) {
    if (Number(occupied) !== 0) throw new Error('--bootstrap requires an empty public schema; existing data is never reset.');
    await psql(['-f', fileURLToPath(new URL('../database/schema.sql', import.meta.url))]);
  } else if (Number(occupied) === 0) throw new Error('Empty database: pass --bootstrap to apply schema.sql first.');
  // Check before writing local fixtures. The SQL repeats this check under a lock.
  const accounts = await psql(['-At', '-c', 'SELECT count(*) FROM public.users'], { capture: true });
  if (Number(accounts) !== 0) throw new Error('Seed requires zero application accounts. Create another seed database for a new run.');
  for (let n = 1; n <= counts.workers; n++) for (const round of n > 1 && [1, 2, 3].includes(n % 10) ? [1, 2] : [1]) {
    const key = `identities/worker-${n}/submission-${round}.pdf`;
    const relative = `objects/seed-private-identities/${key}`;
    const path = join(output, relative);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    manifest.assets.push({ bucket: 'seed-private-identities', key, path: relative, sizeBytes: bytes.length, sha256: pdfHash, contentType: 'application/pdf' });
  }
  const vars = Object.entries({ ...counts, pdf_bytes: bytes.length, pdf_sha256: pdfHash }).flatMap(([key, value]) => ['-v', `${key}=${value}`]);
  await psql([...vars, '-f', fileURLToPath(new URL('./development-seed.sql', import.meta.url))]);
  const detail = await psql(['-At', '-c', `SELECT json_build_object(
    'counts',(SELECT json_object_agg(tablename,n) FROM (SELECT 'users' AS tablename,count(*) AS n FROM users UNION ALL SELECT 'workers',count(*) FROM worker_profiles UNION ALL SELECT 'publicWorkers',count(*) FROM public_worker_profiles UNION ALL SELECT 'requests',count(*) FROM service_requests UNION ALL SELECT 'messages',count(*) FROM messages UNION ALL SELECT 'reviews',count(*) FROM reviews UNION ALL SELECT 'notifications',count(*) FROM notifications UNION ALL SELECT 'deliveries',count(*) FROM notification_deliveries) x),
    'accounts',(SELECT json_object_agg(label,json_build_object('id',u.id,'phoneNumber',u.phone_number,'workerId',w.id)) FROM (VALUES ('customer','+96170000001'),('worker','+96170000002'),('admin','+96170000003')) a(label,phone) JOIN users u ON u.phone_number=a.phone LEFT JOIN worker_profiles w ON w.user_id=u.id))`], { capture: true });
  Object.assign(manifest, JSON.parse(detail), { completedAt: new Date().toISOString(), successful: true });
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const values = Object.entries(manifest.accounts).flatMap(([actor, value]) => [
    { key: `${actor}Phone`, value: value.phoneNumber, enabled: true },
    { key: actor === 'worker' ? 'workerUserId' : `${actor}Id`, value: value.id, enabled: true },
    ...(value.workerId ? [{ key: 'workerId', value: value.workerId, enabled: true }] : [])
  ]);
  await writeFile(join(output, 'M3allem_Seed.postman_environment.json'), `${JSON.stringify({ name: 'M3allem Seed (local API + Neon development DB)', values: [
    { key: 'rootUrl', value: 'http://localhost:3001', enabled: true }, { key: 'baseUrl', value: '{{rootUrl}}/v1', enabled: true }, ...values
  ], _postman_variable_scope: 'environment' }, null, 2)}\n`);
  console.log(`Seed complete. Counts: ${JSON.stringify(manifest.counts)}. Manifest and private sample PDFs: ${output}`);
} finally {
  await writeFile(join(output, 'seed.log'), log.join('\n'));
}
