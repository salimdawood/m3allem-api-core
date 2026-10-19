import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('m3allem-api'),
  JWT_AUDIENCE: z.string().default('m3allem-android'),
  OTP_HMAC_SECRET: z.string().min(32),
  OTP_FIXED_CODE: z.string().regex(/^\d{6}$/).optional(),
  DELIVERY_MODE: z.enum(['live', 'mock']).default('live'),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  RATE_LIMIT_REDIS_URL: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  S3_REGION: z.string().default('us-east-1'), S3_ENDPOINT: z.string().optional(),
  S3_PROFILE_BUCKET: z.string().optional(), S3_IDENTITY_BUCKET: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  OTP_EMAIL_FROM: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  PUSH_DELIVERY_ENABLED: z.enum(['true','false']).transform((v) => v === 'true').optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(60000)
}).superRefine((env, ctx) => {
  if (env.DELIVERY_MODE === 'mock' && (env.APP_ENV === 'production' || env.NODE_ENV === 'production')) {
    ctx.addIssue({ code: 'custom', path: ['DELIVERY_MODE'], message: 'Mock delivery is forbidden in production' });
  }
  if (env.OTP_FIXED_CODE && env.APP_ENV === 'production') {
    ctx.addIssue({ code: 'custom', path: ['OTP_FIXED_CODE'], message: 'Fixed OTP is forbidden in production' });
  }
  if(env.NODE_ENV==='production'&&env.APP_ENV!=='production'){
    ctx.addIssue({code:'custom',path:['APP_ENV'],message:'Production Node deployments must use APP_ENV=production'});
  }
  if (env.APP_ENV === 'staging' && env.OTP_FIXED_CODE !== '111111') {
    ctx.addIssue({ code: 'custom', path: ['OTP_FIXED_CODE'], message: 'Staging must use the documented fixed code' });
  }
  if (env.APP_ENV === 'production' && env.OTP_RATE_LIMIT_MAX > 5) {
    ctx.addIssue({ code: 'custom', path: ['OTP_RATE_LIMIT_MAX'], message: 'Production OTP limits must be five requests per hour or fewer' });
  }
  if(env.APP_ENV==='production'&&!env.RATE_LIMIT_REDIS_URL){
    ctx.addIssue({code:'custom',path:['RATE_LIMIT_REDIS_URL'],message:'Production rate limiting requires a Redis URL'});
  }
  if(env.APP_ENV==='production'){
    for(const key of ['S3_PROFILE_BUCKET','S3_IDENTITY_BUCKET','S3_PUBLIC_BASE_URL','OTP_EMAIL_FROM','FCM_PROJECT_ID']){
      if(!env[key])ctx.addIssue({code:'custom',path:[key],message:`${key} is required in production`});
    }
    if(env.JWT_ACCESS_SECRET==='replace-with-at-least-32-random-characters'||env.OTP_HMAC_SECRET==='replace-with-a-different-32-character-secret'){
      ctx.addIssue({code:'custom',path:['JWT_ACCESS_SECRET'],message:'Replace example secrets before production'});
    }
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
