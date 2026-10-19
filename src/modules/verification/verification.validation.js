import { z } from 'zod';
import { idSchema, pathIdSchema } from '../../utils/id.js';
const empty = z.object({}).strict().default({});
const path = z.object({ documentId: pathIdSchema });
const page = z.object({ afterId: pathIdSchema.optional(), limit: z.preprocess((v) => v === undefined ? 50 :
  typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v, z.number().int().min(1).max(200)) }).strict();
export const verificationSchemas = {
  submit: z.object({ body: z.object({ type: z.enum(['NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE']), uploadId: idSchema }).strict(), params: empty, query: empty }),
  current: z.object({ body: empty, params: empty, query: empty }),
  history: z.object({ body: empty, params: empty, query: page }),
  pending: z.object({ body: empty, params: empty, query: page.extend({ status: z.literal('PENDING').default('PENDING') }) }),
  id: z.object({ body: empty, params: path, query: empty }),
  reject: z.object({ body: z.object({ reason: z.string().trim().min(1).max(500) }).strict(), params: path, query: empty })
};
