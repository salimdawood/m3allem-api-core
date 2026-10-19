import { z } from 'zod';
import { idSchema, pathIdSchema } from '../../utils/id.js';

const empty = z.object({}).strict().default({});
const id = z.object({ id: pathIdSchema });
const limit = z.preprocess((value) => value === undefined ? 50 : typeof value === 'string' && /^\d+$/.test(value)
  ? Number(value) : value, z.number().int().min(1).max(200));
const page = z.object({ limit, cursor: z.string().min(1).max(1024).optional() }).strict();
const review = { rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).nullable().optional() };
export const interactionSchemas = {
  id: z.object({ body: empty, params: id, query: empty }),
  page: z.object({ body: empty, params: empty, query: page }),
  start: z.object({ body: z.object({ workerId: idSchema }).strict(), params: empty, query: empty }),
  messages: z.object({ body: empty, params: id, query: z.object({ beforeNumber: pathIdSchema.optional(), limit }).strict() }),
  message: z.object({ body: z.object({ text: z.string().trim().min(1).max(2000) }).strict(), params: id, query: empty }),
  messageId: z.object({ body: empty, params: z.object({ id: pathIdSchema, messageId: pathIdSchema }), query: empty }),
  createRequest: z.object({ body: z.object({ workerId: idSchema, details: z.string().trim().min(1).max(1000).nullable().optional(),
    scheduledAt: z.number().int().positive().max(8640000000000000).nullable().optional() }).strict(), params: empty, query: empty }),
  requests: z.object({ body: empty, params: empty, query: page.extend({ as: z.enum(['worker', 'customer']).default('customer'),
    status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED']).optional() }) }),
  updateRequest: z.object({ body: z.object({ status: z.enum(['ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED']),
    version: idSchema, reason: z.string().trim().min(1).max(500).nullable().optional() }).strict()
    .refine((v) => v.reason == null || ['DECLINED', 'CANCELLED'].includes(v.status)), params: id, query: empty }),
  events: z.object({ body: empty, params: id, query: z.object({ afterVersion: pathIdSchema.optional(), limit }).strict() }),
  reviews: z.object({ body: empty, params: id, query: page }),
  addReview: z.object({ body: z.object({ requestId: idSchema, ...review }).strict(), params: id, query: empty }),
  editReview: z.object({ body: z.object(review).strict(), params: id, query: empty })
};
