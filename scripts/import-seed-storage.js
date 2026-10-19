import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { seedArtifactTarget } from './seed-target.js';

const target = seedArtifactTarget();
const root = target.root;
const manifestPath = resolve(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const endpoint = new URL(process.env.S3_ENDPOINT);
const database = new URL(process.env.DATABASE_URL);
if (!manifest.successful || process.env.APP_ENV !== 'staging' || process.env.PUSH_DELIVERY_ENABLED !== 'false' ||
    manifest.database !== target.database || manifest.branchId !== target.branchId || manifest.host !== target.host ||
    database.pathname !== `/${manifest.database}` ||
    database.hostname.replace('-pooler.', '.') !== manifest.host ||
    endpoint.hostname !== `${manifest.branchId}.storage.c-7.us-east-2.aws.neon.tech` ||
    endpoint.protocol !== 'https:' || process.env.S3_IDENTITY_BUCKET !== 'seed-private-identities') {
  throw new Error('Refusing storage import: API, manifest and isolated seed branch must match.');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Validate the entire local inventory before making any provider writes.
const files = await Promise.all(manifest.assets.map(async asset => {
  const path = resolve(root, asset.path);
  if (!path.startsWith(root + sep) || asset.bucket !== 'seed-private-identities' ||
      !/^identities\/worker-\d+\/submission-\d+\.pdf$/.test(asset.key)) throw new Error('Invalid fixture path');
  const bytes = await readFile(path);
  if (bytes.length !== asset.sizeBytes || digest(bytes) !== asset.sha256) throw new Error('Local fixture checksum mismatch');
  return { asset, bytes };
}));
const client = new S3Client({ endpoint: endpoint.href, region: process.env.S3_REGION, forcePathStyle: true, maxAttempts: 2 });
let uploaded = 0, existing = 0, cursor = 0;
try {
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      const { asset, bytes } = files[cursor++];
      const location = { Bucket: asset.bucket, Key: asset.key };
      try {
        const object = await client.send(new GetObjectCommand(location));
        if (digest(await object.Body.transformToByteArray()) !== asset.sha256) throw new Error('Existing object differs; refusing overwrite');
        existing++;
      } catch (error) {
        if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new PutObjectCommand({ ...location, Body: bytes, ContentType: asset.contentType,
          CacheControl: 'private, no-store', ChecksumSHA256: Buffer.from(asset.sha256, 'hex').toString('base64'),
          ServerSideEncryption: 'AES256', IfNoneMatch: '*' }));
        const object = await client.send(new GetObjectCommand(location));
        if (digest(await object.Body.transformToByteArray()) !== asset.sha256) throw new Error('Remote fixture checksum mismatch');
        uploaded++;
      }
      if ((uploaded + existing) % 100 === 0) console.log(`Verified ${uploaded + existing}/${files.length} private PDFs`);
    }
  }));
  const sample = files[0].asset;
  const plainUrl = `${endpoint.href.replace(/\/$/, '')}/${sample.bucket}/${sample.key}`;
  const anonymous = await fetch(plainUrl, { signal: AbortSignal.timeout(15000) });
  await anonymous.arrayBuffer();
  if (![401, 403].includes(anonymous.status)) throw new Error(`Unexpected anonymous private-object response: ${anonymous.status}`);
  const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket: sample.bucket, Key: sample.key }), { expiresIn: 60 });
  const response = await fetch(signed, { signal: AbortSignal.timeout(15000) });
  if (!response.ok || digest(Buffer.from(await response.arrayBuffer())) !== sample.sha256) throw new Error('Signed download verification failed');
  manifest.storageState = 'UPLOADED_AND_CHECKSUM_VERIFIED';
  manifest.storageVerifiedAt = new Date().toISOString();
  manifest.storageVerification = { objects: files.length, anonymousStatus: anonymous.status, signedDownload: true };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ uploaded, existing, verified: files.length, anonymousStatus: anonymous.status, signedDownload: true }));
} catch (error) {
  console.error(JSON.stringify({ name: error.name, code: error.code, status: error.$metadata?.httpStatusCode,
    detail: error.$metadata ? undefined : error.message }));
  process.exitCode = 1;
} finally {
  client.destroy();
}
