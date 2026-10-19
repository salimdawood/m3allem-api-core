import { z } from 'zod';
import { idSchema, pathIdSchema } from '../../utils/id.js';

const empty = z.object({}).strict().default({});
const path = z.object({ id: pathIdSchema });
const unit = z.enum(['PER_HOUR', 'PER_VISIT', 'PER_JOB', 'PER_SESSION', 'PER_DAY']);
const money = z.number().finite().nonnegative().max(999999999999.99)
  .refine((v) => Number(v.toFixed(2)) === v, 'Use at most two decimal places');
const price = z.object({ amount: money, unit, currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const shift = z.object({ id: idSchema.optional(), isoWeekday: z.number().int().min(1).max(7),
  opensAt: time, closesAt: time, endDayOffset: z.union([z.literal(0), z.literal(1)]).default(0)
}).strict().refine((v) => v.endDayOffset === 0 ? v.closesAt > v.opensAt : v.closesAt <= v.opensAt,
  'Shift duration must be positive and at most 24 hours');
const uniqueIds = (items) => new Set(items.filter((x) => x.id !== undefined).map((x) => x.id)).size === items.filter((x) => x.id !== undefined).length;
const draft = z.object({
  publicPhoneNumber: z.string().trim().min(7).max(24), whatsappNumber: z.string().trim().min(7).max(24).nullable().optional(),
  categoryId: idSchema, workerTypeIds: z.array(idSchema).min(1).max(20).refine((ids) => new Set(ids).size === ids.length),
  description: z.string().trim().min(1).max(1000), experienceYears: z.number().int().min(0).max(80),
  services: z.array(z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(120),
    description: z.string().max(500).nullable().optional(), price: price.nullable().optional()
  }).strict()).max(40).refine(uniqueIds),
  startingPrice: price.nullable().optional(),
  workingHours: z.object({ timeZone: z.string().min(1).max(100).default('Asia/Beirut'),
    shifts: z.array(shift).max(100).refine(uniqueIds) }).strict(),
  location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
    address: z.string().max(255).nullable().optional() }).strict(),
  isAvailable: z.boolean().default(true), isListed: z.boolean().default(true)
}).strict();
const number = (min, max, fallback) => z.preprocess((value) => value === undefined ? fallback :
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value, z.number().finite().min(min).max(max));
const bool = z.union([z.literal('true'), z.literal('false')]).transform((v) => v === 'true').default('false');
const search = z.object({
  query: z.string().trim().min(1).max(200).optional(), categoryId: pathIdSchema.optional(), workerTypeId: pathIdSchema.optional(),
  minRating: number(0, 5).optional(), lat: number(-90, 90).optional(), lng: number(-180, 180).optional(),
  maxDistanceKm: number(0, 500).optional(), discountOnly: bool, availableOnly: bool, favoritesOnly: bool,
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), priceUnit: unit.optional(),
  sort: z.enum(['RELEVANCE', 'RATING', 'DISTANCE', 'PRICE']).default('RELEVANCE'),
  limit: number(1, 200, 50).pipe(z.number().int()), cursor: z.string().min(1).max(1024).optional()
}).strict().refine((q) => (q.lat === undefined) === (q.lng === undefined), 'Supply both coordinates')
  .refine((q) => (q.sort !== 'DISTANCE' && q.maxDistanceKm === undefined) || q.lat !== undefined, 'Distance needs coordinates')
  .refine((q) => (q.currency === undefined) === (q.priceUnit === undefined), 'Supply currency and priceUnit together')
  .refine((q) => q.sort !== 'PRICE' || q.currency !== undefined, 'Price sorting needs currency and priceUnit');
export const workerSchemas = {
  search: z.object({ body: empty, params: empty, query: search }),
  nearby: z.object({ body: empty, params: empty, query: z.object({ lat: number(-90, 90), lng: number(-180, 180),
    radiusKm: number(0, 500, 10), limit: number(1, 200, 50).pipe(z.number().int()) }).strict() }),
  id: z.object({ body: empty, params: path, query: empty }),
  draft: z.object({ body: draft, params: empty, query: empty }),
  update: z.object({ body: draft, params: path, query: empty }),
  discount: z.object({ body: z.discriminatedUnion('type', [
    z.object({ type: z.literal('PERCENTAGE'), value: money.refine((v) => v > 0 && v <= 100),
      title: z.string().trim().min(1).max(80).optional(), expiresAt: z.number().int().positive().max(8640000000000000).optional() }).strict(),
    z.object({ type: z.literal('FIXED_AMOUNT'), value: money.refine((v) => v > 0), currency: z.string().regex(/^[A-Z]{3}$/), unit,
      title: z.string().trim().min(1).max(80).optional(), expiresAt: z.number().int().positive().max(8640000000000000).optional() }).strict()
  ]), params: path, query: empty }),
  availability: z.object({ body: z.object({ isAvailable: z.boolean() }).strict(), params: path, query: empty }),
  listing: z.object({ body: z.object({ isListed: z.boolean() }).strict(), params: path, query: empty })
};
