import { z } from 'zod';
import { idSchema } from '../../utils/id.js';

const phone = z.string().trim().min(7).max(24);
const email = z.string().trim().email().max(255);
const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), address: z.string().trim().max(255).optional() }).strict().optional();
export const schemas = {
  phone: z.object({ body: z.object({ phoneNumber: phone }).strict(), params: z.object({}), query: z.object({}) }),
  verify: z.object({ body: z.object({ phoneNumber: phone, challengeId: idSchema, code: z.string().regex(/^\d{6}$/) }).strict(), params: z.object({}), query: z.object({}) }),
  register: z.object({ body: z.object({ fullName: z.string().trim().min(1).max(120), location, nationality: z.string().regex(/^[A-Za-z]{2}$/).nullable().optional() }).strict(), params: z.object({}), query: z.object({}) }),
  refresh: z.object({ body: z.object({ refreshToken: z.string().min(20) }).strict(), params: z.object({}), query: z.object({}) }),
  logout: z.object({ body: z.object({ fcmToken: z.string().max(4096).optional() }).strict(), params: z.object({}), query: z.object({}) }),
  recovery: z.object({ body: z.object({ email }).strict(), params: z.object({}), query: z.object({}) }),
  recoveryVerify: z.object({ body: z.object({ email, code: z.string().regex(/^\d{6}$/) }).strict(), params: z.object({}), query: z.object({}) }),
  newPhone: z.object({ body: z.object({ newPhoneNumber: phone }).strict(), params: z.object({}), query: z.object({}) }),
  confirmPhone: z.object({ body: z.object({ newPhoneNumber: phone, challengeId: idSchema, code: z.string().regex(/^\d{6}$/) }).strict(), params: z.object({}), query: z.object({}) }),
  confirmEmail: z.object({ body: z.object({ email, challengeId: idSchema, code: z.string().regex(/^\d{6}$/) }).strict(), params: z.object({}), query: z.object({}) })
};
