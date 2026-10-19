import { createHash } from 'node:crypto';
import { AppError } from './AppError.js';
import { idNumber } from './id.js';

const fingerprint = (scope) => createHash('sha256').update(JSON.stringify(scope)).digest('hex');
export function decodePageCursor(encoded, scope) {
  if (!encoded) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.scope !== fingerprint(scope) || typeof value.id !== 'number' || typeof value.at !== 'string' ||
      !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at)) throw new Error();
    const milliseconds = value.at.slice(0, 23) + 'Z';
    if (!Number.isFinite(Date.parse(milliseconds)) || new Date(milliseconds).toISOString() !== milliseconds) throw new Error();
    idNumber(value.id);
    return value;
  } catch { throw new AppError('INVALID_REQUEST', 400, 'Invalid page cursor'); }
}
export function pageResult(rows, limit, scope, dto) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return { items: selected.map(dto), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({
    v: 1, scope: fingerprint(scope), at: last.cursorAt, id: idNumber(last.id)
  })).toString('base64url') : null };
}
