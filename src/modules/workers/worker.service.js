import { createHash } from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';
import { workerRepository as repo } from './worker.repository.js';
import { realtimeHub } from '../realtime/hub.js';

const normalizedPhone = (value) => {
  const digits = value.replace(/[\s()+-]/g, '').replace(/^00/, '');
  const national = digits.startsWith('961') ? digits.slice(3).replace(/^0/, '') : digits.replace(/^0/, '');
  if (!/^\d{7,8}$/.test(national)) throw new AppError('INVALID_PHONE', 400);
  return `+961${national}`;
};
function normalizedDraft(input) {
  const spans = [];
  for (const shift of input.workingHours.shifts) {
    const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = (shift.isoWeekday - 1) * 1440 + minutes(shift.opensAt);
    const end = (shift.isoWeekday - 1 + shift.endDayOffset) * 1440 + minutes(shift.closesAt);
    if (end <= 10080) spans.push([start, end]);
    else { spans.push([start, 10080]); spans.push([0, end - 10080]); }
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some((span, i) => i > 0 && span[0] < spans[i - 1][1])) throw new AppError('OVERLAPPING_HOURS', 400);
  return { ...input, publicPhoneNumber: normalizedPhone(input.publicPhoneNumber),
    whatsappNumber: input.whatsappNumber ? normalizedPhone(input.whatsappNumber) : null };
}
function workerDto(row) {
  if (!row) throw new AppError('NOT_FOUND', 404);
  const { score: _score, effectivePriceAmount, ...worker } = row;
  return { ...worker, id: idNumber(row.id), userId: idNumber(row.userId), categoryId: idNumber(row.categoryId),
    profileImageUploadId: row.profileImageUploadId == null ? null : idNumber(row.profileImageUploadId),
    workerTypeIds: row.workerTypeIds.map(idNumber),
    services: row.services.map((s) => ({ ...s, id: idNumber(s.id) })),
    workingHours: { ...row.workingHours, shifts: row.workingHours.shifts.map((s) => ({ ...s, id: idNumber(s.id) })) },
    discount: row.discount ? { ...row.discount, id: idNumber(row.discount.id) } : null,
    rating: Number(row.rating),
    effectiveStartingPrice: row.startingPrice == null ? null : { ...row.startingPrice, amount: Number(effectivePriceAmount) }
  };
}
async function withFavorites(rows, userId) {
  const favorites = new Set(await repo.favoriteIds(userId, rows.map((row) => row.id)));
  return rows.map((row) => ({ ...workerDto(row), isFavorite: favorites.has(idNumber(row.id)) }));
}
function scopeFor(input, userId) {
  const { cursor: _cursor, limit: _limit, ...filters } = input;
  return createHash('sha256').update(JSON.stringify({ userId, filters })).digest('hex');
}
function decodeCursor(encoded, scope) {
  if (!encoded) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.scope !== scope || typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0 ||
      typeof value.id !== 'number') throw new Error();
    idNumber(value.id);
    return value;
  } catch { throw new AppError('INVALID_REQUEST', 400, 'Invalid worker search cursor'); }
}
function nextCursor(row, input, scope) {
  const value = input.sort === 'PRICE' ? Number(row.effectivePriceAmount) : input.sort === 'DISTANCE' ? row.distanceKm
    : input.sort === 'RATING' ? Number(row.rating) : row.score;
  return Buffer.from(JSON.stringify({ v: 1, scope, value, id: idNumber(row.id) })).toString('base64url');
}
const changed = async (id, userId) => {
  const result = workerDto(await repo.byId(id, userId, true));
  void realtimeHub.publish(userId, 'worker.updated', result);
  return result;
};
export const workerService = {
  async search(input, userId) {
    const scope = scopeFor(input, userId);
    const rows = await repo.search(input, userId, decodeCursor(input.cursor, scope));
    const more = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return { items: await withFavorites(page, userId), nextCursor: more ? nextCursor(page.at(-1), input, scope) : null };
  },
  async nearby(input, userId) {
    const rows = await repo.search({ ...input, maxDistanceKm: input.radiusKm, sort: 'DISTANCE' }, userId);
    return withFavorites(rows.slice(0, input.limit), userId);
  },
  async getById(id, userId) {
    const row = await repo.byId(id);
    if (!row) throw new AppError('NOT_FOUND', 404);
    return (await withFavorites([row], userId))[0];
  },
  async mine(userId) { return workerDto(await repo.byUserId(userId)); },
  async create(userId, input) {
    const id = await repo.create(userId, normalizedDraft(input));
    return changed(id, userId);
  },
  async update(userId, id, input) {
    await repo.update(id, userId, normalizedDraft(input));
    return changed(id, userId);
  },
  async restore(userId, id, input) {
    await repo.update(id, userId, normalizedDraft(input), true);
    return changed(id, userId);
  },
  async setDiscount(userId, id, input) {
    if (input.expiresAt !== undefined && input.expiresAt <= Date.now()) throw new AppError('INVALID_DISCOUNT', 400);
    await repo.setDiscount(id, userId, input);
    return changed(id, userId);
  },
  async removeDiscount(userId, id) { await repo.removeDiscount(id, userId); return changed(id, userId); },
  async setAvailability(userId, id, isAvailable) { await repo.setFlags(id, userId, { isAvailable }); return changed(id, userId); },
  async setListing(userId, id, isListed) { await repo.setFlags(id, userId, { isListed }); return changed(id, userId); },
  async delete(userId, id) {
    await repo.softDelete(id, userId);
    void realtimeHub.publish(userId, 'worker.deleted', { id });
    return { statusCode: 204 };
  }
};
