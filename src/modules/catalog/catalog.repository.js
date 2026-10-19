import { prisma } from '../../config/database.js';

export const catalogRepository = {
  snapshot: (language) => prisma.$transaction(async (db) => ({
    categories: await db.$queryRaw`SELECT id,slug,name,description,icon_key AS "iconKey",sort_order AS "sortOrder"
      FROM catalog_categories(${language})`,
    workerTypes: await db.$queryRaw`SELECT id,category_id AS "categoryId",slug,name,local_name AS "localName",
      icon_key AS "iconKey",keywords,sort_order AS "sortOrder" FROM catalog_worker_types(${language})`
  }), { isolationLevel: 'RepeatableRead' }),
  banners: (language) => prisma.$queryRaw`SELECT id,title,subtitle,image_url AS "imageUrl",icon_key AS "iconKey",
    category_id AS "categoryId",language FROM catalog_banners(${language})`
};
