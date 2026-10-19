import { randomBytes } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';

const client = new S3Client({ region: env.S3_REGION,
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}) });
function publicBase() {
  try {
    const url = new URL(env.S3_PUBLIC_BASE_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (env.APP_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new AppError('STORAGE_UNAVAILABLE', 503); }
}
export const storageRepository = {
  prepare(purpose, userId, extension) {
    const bucketName = purpose === 'PROFILE_IMAGE' ? env.S3_PROFILE_BUCKET : env.S3_IDENTITY_BUCKET;
    if (!bucketName || (purpose === 'PROFILE_IMAGE' && !env.S3_PUBLIC_BASE_URL) ||
      (env.S3_PROFILE_BUCKET && env.S3_PROFILE_BUCKET === env.S3_IDENTITY_BUCKET))
      throw new AppError('STORAGE_UNAVAILABLE', 503);
    if (purpose === 'PROFILE_IMAGE') publicBase();
    const prefix = purpose === 'PROFILE_IMAGE' ? 'profile' : 'identity';
    return { bucketName, objectKey: `${prefix}/${userId}/${randomBytes(24).toString('hex')}.${extension}` };
  },
  async put(location, buffer, contentType, sha256, purpose) {
    try {
      await client.send(new PutObjectCommand({ Bucket: location.bucketName, Key: location.objectKey, Body: buffer,
        ContentType: contentType, ChecksumSHA256: sha256.toString('base64'), ServerSideEncryption: 'AES256',
        CacheControl: purpose === 'PROFILE_IMAGE' ? 'public, max-age=31536000, immutable' : 'private, no-store' }));
    } catch { throw new AppError('STORAGE_UNAVAILABLE', 503); }
  },
  publicUrl(location) {
    return `${publicBase()}/${location.objectKey.split('/').map(encodeURIComponent).join('/')}`;
  },
  async identityUrl(location) {
    try {
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: location.bucketName, Key: location.objectKey,
        ResponseCacheControl: 'private, no-store', ResponseContentDisposition: 'inline' }), { expiresIn: 300 });
    } catch { throw new AppError('STORAGE_UNAVAILABLE', 503); }
  }
};
