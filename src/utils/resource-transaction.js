import { prisma } from '../config/database.js';

// Retry only database work; external storage/network calls belong outside.
export async function resourceTransaction(callback) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (db) => {
        const result = await callback(db);
        await db.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        return result;
      }, { timeout: 15000 });
    } catch (error) {
      if (attempt < 2 && (error.code === 'P2034' || ['40P01', '40001'].includes(error.meta?.code))) continue;
      throw error;
    }
  }
}
