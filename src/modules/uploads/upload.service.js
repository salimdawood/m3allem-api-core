import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { createHash } from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { logger } from '../../config/logger.js';
import { storageRepository as storage } from './storage.repository.js';
import { uploadRepository as repo } from './upload.repository.js';

async function inspect(file, purpose) {
  if (!file?.buffer?.length) throw new AppError('DOCUMENT_REQUIRED', 400);
  const type = await fileTypeFromBuffer(file.buffer).catch(() => null);
  if (purpose === 'IDENTITY_DOCUMENT' && type?.mime === 'application/pdf') {
    // Keep PDF originals private. This signature check is not a malware scan.
    if (!file.buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new AppError('INVALID_DOCUMENT', 400);
    return { buffer: file.buffer, contentType: type.mime, extension: 'pdf' };
  }
  const allowed = purpose === 'PROFILE_IMAGE' ? ['image/jpeg', 'image/png', 'image/webp'] : ['image/jpeg', 'image/png'];
  if (!allowed.includes(type?.mime)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415);
  try {
    const image = sharp(file.buffer, { limitInputPixels: 25_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1) throw new Error('Multiple pages');
    const buffer = await image.rotate().resize({ width: purpose === 'PROFILE_IMAGE' ? 1024 : 4096,
      height: purpose === 'PROFILE_IMAGE' ? 1024 : 4096, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: purpose === 'PROFILE_IMAGE' ? 85 : 95 }).toBuffer();
    return { buffer, contentType: 'image/jpeg', extension: 'jpg' };
  } catch { throw new AppError('INVALID_IMAGE', 400); }
}
const dto = (row) => ({ id: idNumber(row.id), purpose: row.purpose, status: row.status,
  contentType: row.contentType, sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
  createdAt: row.createdAt.getTime(), uploadedAt: row.uploadedAt?.getTime() ?? null,
  failureCode: row.failureCode ?? null });
async function upload(userId, file, purpose) {
  const inspected = await inspect(file, purpose);
  if (inspected.buffer.length > (purpose === 'PROFILE_IMAGE' ? 5 : 10) * 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 413);
  const location = storage.prepare(purpose, userId, inspected.extension);
  const row = await repo.reserve(userId, purpose, location);
  const sha256 = createHash('sha256').update(inspected.buffer).digest();
  let written = false;
  try {
    await storage.put(location, inspected.buffer, inspected.contentType, sha256, purpose);
    written = true;
    const ready = await repo.ready(row.id, userId, inspected.contentType, inspected.buffer.length, sha256);
    return { ...dto(ready), ...(purpose === 'PROFILE_IMAGE' ? { url: storage.publicUrl(location) } : {}) };
  } catch (error) {
    try { await repo.fail(row.id, userId, written ? 'UPLOAD_FINALIZATION_FAILED' : 'STORAGE_WRITE_FAILED'); }
    catch (failure) { logger.error({ code: failure.code, uploadId: String(row.id) }, 'Upload failure state could not be recorded'); }
    // Retain the object and metadata for reconciliation; no implicit purge.
    throw error;
  }
}
export const uploadService = {
  async list(userId, query) {
    const rows = await repo.list(userId, query);
    return { items: rows.slice(0, query.limit).map(dto),
      nextAfterId: rows.length > query.limit ? idNumber(rows[query.limit - 1].id) : null };
  },
  profileImage: (userId, file) => upload(userId, file, 'PROFILE_IMAGE'),
  identityDocument: (userId, file) => upload(userId, file, 'IDENTITY_DOCUMENT'),
  async get(id, userId) {
    const row = await repo.accessible(id, userId);
    if (!row) throw new AppError('NOT_FOUND', 404);
    return { ...dto(row), url: row.status !== 'READY' ? null : row.purpose === 'PROFILE_IMAGE'
      ? storage.publicUrl(row) : await storage.identityUrl(row),
      ...(row.status === 'READY' && row.purpose === 'IDENTITY_DOCUMENT' ? { expiresIn: 300 } : {}) };
  },
  async delete(id, userId) { await repo.softDelete(id, userId); return { statusCode: 204 }; },
  async restore(id, userId) { return dto(await repo.restore(id, userId)); }
};
