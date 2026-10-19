import { z } from 'zod';
import { idSchema, pathIdSchema } from '../../utils/id.js';

const empty = z.object({}).default({});
const pathId = (key = 'id') => z.object({ [key]: pathIdSchema });
export const accountSchemas = {
  profile: z.object({ body: z.object({ fullName: z.string().trim().min(1).max(120).optional(),
    profileImageUploadId: idSchema.nullable().optional(),
    location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), address: z.string().max(255).optional() }).strict().nullable().optional(),
    nationality: z.string().regex(/^[a-zA-Z]{2}$/).nullable().optional() }).strict().refine((x) => Object.keys(x).length > 0), params: empty, query: empty }),
  publicUser: z.object({ body: empty, params: pathId(), query: empty }),
  settings: z.object({ body: z.object({ notificationsEnabled: z.boolean(), reminderLeadMinutes: z.union([z.literal(0),z.literal(5),z.literal(15),z.literal(30),z.literal(60),z.literal(120),z.literal(1440)]), language: z.enum(['en','fr','ar']) }).strict(), params: empty, query: empty }),
  workerParam: z.object({ body: empty, params: pathId('workerId'), query: empty }),
  notificationParam: z.object({ body: empty, params: pathId(), query: empty }),
  device: z.object({ body: z.object({ fcmToken: z.string().min(10).max(4096), platform: z.literal('android').default('android'), locale: z.enum(['en','fr','ar']).optional(), appVersion: z.string().max(32).optional() }).strict(), params: empty, query: empty }),
  fcmParam: z.object({ body: empty, params: z.object({ fcmToken: z.string().min(10).max(4096) }), query: empty }),
  contact: z.object({ body: z.object({ workerId: idSchema, interactionType: z.enum(['CALL','WHATSAPP']) }).strict(), params: empty, query: empty }),
  deleteAccount: z.object({ body: z.object({}).strict().default({}), params: empty, query: empty }),
  accountStatus: z.object({ body: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ACTIVE') }).strict(),
    z.object({ status: z.literal('SUSPENDED'), reason: z.string().trim().min(1).max(500) }).strict()
  ]), params: pathId(), query: empty })
};
