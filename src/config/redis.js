import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';
import { env } from './env.js';
import { logger } from './logger.js';

let client;
export const getRedis=()=>{
  if(!env.RATE_LIMIT_REDIS_URL)return null;
  // Rate-limit stores load their scripts before the lazy connection is ready.
  // Queue those commands, but bound both connection and command waits.
  if(!client){client=new Redis(env.RATE_LIMIT_REDIS_URL,{lazyConnect:true,maxRetriesPerRequest:1,enableOfflineQueue:true,connectTimeout:5000,commandTimeout:5000});client.on('error',(error)=>logger.warn({code:error.code},'Rate limit Redis connection error'));}
  return client;
};
export const redisRateLimitStore=(prefix)=>{
  const redis=getRedis();
  return redis?new RedisStore({prefix,sendCommand:(...args)=>redis.call(...args)}):undefined;
};
export const closeRedis=async()=>{if(client){await client.quit();client=null;}};
