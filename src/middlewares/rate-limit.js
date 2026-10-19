import { rateLimit } from 'express-rate-limit';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { redisRateLimitStore } from '../config/redis.js';

const store=(prefix)=>redisRateLimitStore(prefix);
const handler=(_req,_res,next)=>next(new AppError('RATE_LIMITED',429));
const otpDestinationKey=(req)=>{
  const value=String(req.body?.phoneNumber??req.body?.newPhoneNumber??req.body?.email??'unknown').trim().toLowerCase();
  if(value.includes('@'))return `email:${value}`;
  const digits=value.replace(/\D/g,'').replace(/^00/,'');
  const national=digits.startsWith('961')?digits.slice(3).replace(/^0/,''):digits.replace(/^0/,'');
  return `phone:${/^\d{7,8}$/.test(national)?`+961${national}`:digits}`;
};
export const apiRateLimit=rateLimit({windowMs:5*60_000,limit:300,standardHeaders:true,legacyHeaders:false,store:store('api:'),handler,skip:req=>req.path.startsWith('/health')||req.path==='/v1/health'});
export const otpIpLimit=rateLimit({windowMs:60*60_000,limit:env.OTP_RATE_LIMIT_MAX,standardHeaders:true,legacyHeaders:false,store:store('otp:ip:'),handler});
export const otpDestinationLimit=rateLimit({windowMs:60*60_000,limit:env.OTP_RATE_LIMIT_MAX,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>otpDestinationKey(req),store:store('otp:destination:'),handler});
export const otpRateLimits=[otpIpLimit,otpDestinationLimit];
