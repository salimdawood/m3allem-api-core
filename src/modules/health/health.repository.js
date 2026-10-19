import { prisma } from '../../config/database.js';
export const healthRepository={checkDatabase:()=>prisma.$transaction(async(tx)=>{await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2000ms'");await tx.$queryRaw`SELECT 1`;},{maxWait:500,timeout:2500})};
