import { z } from 'zod';
import { pathIdSchema } from '../../utils/id.js';
export const uploadIdSchema = z.object({ body: z.object({}).strict().default({}),
  params: z.object({ id: pathIdSchema }), query: z.object({}).strict() });
export const uploadListSchema = z.object({ body: z.object({}).strict().default({}), params: z.object({}).strict(),
  query: z.object({ afterId: pathIdSchema.optional(), limit: z.preprocess((v) => v === undefined ? 50 :
    typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v, z.number().int().min(1).max(200)) }).strict() });
