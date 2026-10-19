import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { idNumber } from '../../utils/id.js';

const source = (privateRead) => privateRead
  ? Prisma.sql`SELECT p.*,u.full_name,u.profile_image_upload_id,v.verification_status
      FROM active_worker_profiles p JOIN active_users u ON u.id=p.user_id
      JOIN worker_verification v ON v.worker_id=p.id WHERE u.account_status='ACTIVE'`
  : Prisma.sql`SELECT p.*,TRUE AS is_listed FROM public_worker_profiles p`;
const effectivePrice = Prisma.sql`CASE WHEN d.type='PERCENTAGE' THEN round(w.starting_price_amount*(1-d.value/100),2)
  WHEN d.type='FIXED_AMOUNT' THEN w.starting_price_amount-d.value ELSE w.starting_price_amount END`;
const projection = (privateRead = false) => Prisma.sql`SELECT w.id,w.user_id AS "userId",w.full_name AS "fullName",
  w.profile_image_upload_id AS "profileImageUploadId",w.public_phone_number AS "publicPhoneNumber",
  w.whatsapp_number AS "whatsappNumber",w.category_id AS "categoryId",w.description,w.experience_years AS "experienceYears",
  COALESCE((SELECT jsonb_agg(x.worker_type_id::text ORDER BY x.position) FROM active_worker_worker_types x
    JOIN active_worker_types t ON t.id=x.worker_type_id WHERE x.worker_id=w.id AND (${privateRead} OR t.is_active)),'[]') AS "workerTypeIds",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id::text,'name',s.name,'description',s.description,'price',
    CASE WHEN s.price_amount IS NULL THEN NULL ELSE jsonb_build_object('amount',s.price_amount,'unit',s.price_unit,'currency',s.price_currency) END)
    ORDER BY s.sort_order,s.id) FROM active_worker_services s WHERE s.worker_id=w.id),'[]') AS services,
  CASE WHEN w.starting_price_amount IS NULL THEN NULL ELSE jsonb_build_object('amount',w.starting_price_amount,
    'unit',w.starting_price_unit,'currency',w.starting_price_currency) END AS "startingPrice",
  w.effective_price AS "effectivePriceAmount",
  (SELECT jsonb_build_object('id',d.id::text,'type',d.type,'value',d.value,'currency',d.currency,'unit',d.unit,'title',d.title,
    'expiresAt',CASE WHEN d.expires_at IS NULL THEN NULL ELSE (extract(epoch FROM d.expires_at)*1000)::double precision END)
    FROM active_worker_discounts d WHERE d.worker_id=w.id AND (${privateRead} OR d.expires_at IS NULL OR d.expires_at>statement_timestamp())) AS discount,
  jsonb_build_object('timeZone',w.time_zone,'shifts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id::text,
    'isoWeekday',h.iso_weekday,'opensAt',to_char(h.opens_at,'HH24:MI'),'closesAt',to_char(h.closes_at,'HH24:MI'),
    'endDayOffset',h.end_day_offset) ORDER BY h.iso_weekday,h.opens_at,h.id)
    FROM active_worker_working_hours h WHERE h.worker_id=w.id),'[]')) AS "workingHours",
  jsonb_build_object('latitude',w.latitude,'longitude',w.longitude,'address',w.address) AS location,
  w.rating,w.rating_count AS "ratingCount",w.verification_status AS "verificationStatus",w.is_available AS "isAvailable",
  w.is_listed AS "isListed",w.distance_km AS "distanceKm",w.score,
  (extract(epoch FROM w.joined_at)*1000)::double precision AS "joinedAt"`;

async function write(callback) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (db) => {
        const result = await callback(db);
        // Surface SQLSTATE through the query API instead of Prisma's generic
        // commit error. The database still checks the complete final state.
        await db.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        return result;
      }, { timeout: 15000 });
    } catch (error) {
      if (attempt < 2 && (error.code === 'P2034' || ['40P01', '40001'].includes(error.meta?.code))) continue;
      throw error;
    }
  }
}

async function accountLock(db, userId) {
  const account = await db.$queryRaw`SELECT id FROM active_users WHERE id=${userId} AND account_status='ACTIVE' FOR UPDATE`;
  if (!account.length) throw new AppError('NOT_AUTHENTICATED', 401);
}
async function owned(db, id, userId, allowDeleted = false) {
  await accountLock(db, userId);
  const row = (await db.$queryRaw`SELECT id,user_id AS "userId",category_id AS "categoryId",deleted_at AS "deletedAt"
    FROM worker_profiles WHERE id=${id} FOR UPDATE`)[0];
  if (!row || (!allowDeleted && row.deletedAt)) throw new AppError('NOT_FOUND', 404);
  if (idNumber(row.userId) !== idNumber(userId)) throw new AppError('FORBIDDEN', 403);
  return row;
}
async function validateTypes(db, input) {
  const zones = await db.$queryRaw`SELECT name FROM pg_timezone_names WHERE name=${input.workingHours.timeZone}
    AND (name='UTC' OR position('/' IN name)>0) AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'`;
  if (!zones.length) throw new AppError('INVALID_TIME_ZONE', 400);
  const types = await db.$queryRaw`SELECT t.id FROM active_worker_types t JOIN active_categories c ON c.id=t.category_id
    WHERE c.id=${input.categoryId} AND c.is_active AND t.is_active AND t.id=ANY(${input.workerTypeIds}::bigint[])
    FOR SHARE OF c,t`;
  if (types.length !== input.workerTypeIds.length) throw new AppError('INVALID_WORKER_TYPES', 400);
}
const profileData = (input) => ({
  publicPhoneNumber: input.publicPhoneNumber, whatsappNumber: input.whatsappNumber ?? null,
  description: input.description, experienceYears: input.experienceYears,
  startingPriceAmount: input.startingPrice?.amount ?? null, startingPriceUnit: input.startingPrice?.unit ?? null,
  startingPriceCurrency: input.startingPrice?.currency ?? null,
  latitude: input.location.latitude, longitude: input.location.longitude, address: input.location.address ?? null,
  timeZone: input.workingHours.timeZone, isAvailable: input.isAvailable, isListed: input.isListed
});

async function synchronizeChildren(db, id, input) {
  // Restore tombstones separately from payload changes; uniqueness is retained.
  const links = await db.workerWorkerType.findMany({ where: { workerId: id } });
  for (const link of links) if (!link.deletedAt && !input.workerTypeIds.includes(idNumber(link.workerTypeId)))
    await db.workerWorkerType.update({ where: { workerId_workerTypeId: { workerId: id, workerTypeId: link.workerTypeId } }, data: { deletedAt: new Date() } });
  for (const [position, typeId] of input.workerTypeIds.entries()) {
    const key = { workerId: id, workerTypeId: typeId };
    const existing = links.find((link) => idNumber(link.workerTypeId) === typeId);
    if (!existing) await db.workerWorkerType.create({ data: { ...key, categoryId: input.categoryId, position } });
    else {
      if (existing.deletedAt) await db.workerWorkerType.update({ where: { workerId_workerTypeId: key }, data: { deletedAt: null } });
      await db.workerWorkerType.update({ where: { workerId_workerTypeId: key }, data: { position } });
    }
  }
  await synchronizeRows(db, 'workerService', id, input.services, (service, position) => ({
    name: service.name, description: service.description ?? null, priceAmount: service.price?.amount ?? null,
    priceUnit: service.price?.unit ?? null, priceCurrency: service.price?.currency ?? null, sortOrder: position
  }));
  const hours = await db.workerWorkingHours.findMany({ where: { workerId: id } });
  const selected = input.workingHours.shifts;
  for (const row of hours) if (!row.deletedAt && !selected.some((s) => s.id === idNumber(row.id)))
    await db.workerWorkingHours.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  for (const shift of selected) {
    if (shift.id !== undefined) {
      const row = hours.find((h) => idNumber(h.id) === shift.id);
      if (!row) throw new AppError('INVALID_CHILD_ID', 400);
      if (row.deletedAt) await db.workerWorkingHours.update({ where: { id: row.id }, data: { deletedAt: null } });
      await db.$executeRaw`UPDATE active_worker_working_hours SET iso_weekday=${shift.isoWeekday}::smallint,
        opens_at=${shift.opensAt}::time,closes_at=${shift.closesAt}::time,end_day_offset=${shift.endDayOffset}::smallint WHERE id=${row.id}`;
    } else await db.$executeRaw`INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at,end_day_offset)
      VALUES(${id},${shift.isoWeekday}::smallint,${shift.opensAt}::time,${shift.closesAt}::time,${shift.endDayOffset}::smallint)`;
  }
}
async function synchronizeRows(db, model, workerId, selected, dataFor) {
  const rows = await db[model].findMany({ where: { workerId } });
  for (const row of rows) if (!row.deletedAt && !selected.some((s) => s.id === idNumber(row.id)))
    await db[model].update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  for (const [index, item] of selected.entries()) {
    const data = dataFor(item, index);
    if (item.id === undefined) await db[model].create({ data: { workerId, ...data } });
    else {
      const row = rows.find((r) => idNumber(r.id) === item.id);
      if (!row) throw new AppError('INVALID_CHILD_ID', 400);
      if (row.deletedAt) await db[model].update({ where: { id: row.id }, data: { deletedAt: null } });
      await db[model].update({ where: { id: row.id }, data });
    }
  }
}

export const workerRepository = {
  async byId(id, viewerId = null, privateRead = false) {
    return (await prisma.$queryRaw(Prisma.sql`WITH base AS (${source(privateRead)}), found AS (
      SELECT w.*,NULL::double precision AS distance_km,0::double precision AS score,${effectivePrice} AS effective_price
      FROM base w LEFT JOIN active_worker_discounts d ON d.worker_id=w.id
        AND (d.expires_at IS NULL OR d.expires_at>statement_timestamp())
      WHERE w.id=${id} ${privateRead ? Prisma.sql`AND w.user_id=${viewerId}` : Prisma.empty}
    ) ${projection(privateRead)} FROM found w`))[0] ?? null;
  },
  async byUserId(userId) {
    const row = await prisma.workerProfile.findFirst({ where: { userId, deletedAt: null }, select: { id: true } });
    return row ? this.byId(row.id, userId, true) : null;
  },
  favoriteIds: async (userId, ids) => ids.length ? (await prisma.$queryRaw`SELECT worker_id AS id FROM active_favorites
    WHERE user_id=${userId} AND worker_id=ANY(${ids}::bigint[])`).map((r) => idNumber(r.id)) : [],
  async search(input, userId, cursor) {
    const filters = [Prisma.sql`TRUE`];
    if (input.categoryId !== undefined) filters.push(Prisma.sql`w.category_id=${input.categoryId}`);
    if (input.workerTypeId !== undefined) filters.push(Prisma.sql`EXISTS(SELECT 1 FROM active_worker_worker_types x
      JOIN active_worker_types t ON t.id=x.worker_type_id AND t.is_active WHERE x.worker_id=w.id AND x.worker_type_id=${input.workerTypeId})`);
    if (input.minRating !== undefined) filters.push(Prisma.sql`w.rating>=${input.minRating}`);
    if (input.availableOnly) filters.push(Prisma.sql`w.is_available`);
    if (input.favoritesOnly) filters.push(Prisma.sql`EXISTS(SELECT 1 FROM active_favorites f WHERE f.worker_id=w.id AND f.user_id=${userId})`);
    if (input.discountOnly) filters.push(Prisma.sql`d.id IS NOT NULL`);
    if (input.currency) filters.push(Prisma.sql`w.starting_price_currency=${input.currency} AND w.starting_price_unit=${input.priceUnit}::price_unit`);
    const distance = input.lat !== undefined ? Prisma.sql`6371*acos(LEAST(1.0,GREATEST(-1.0,
      sin(radians(${input.lat}::double precision))*sin(radians(w.latitude))+
      cos(radians(${input.lat}::double precision))*cos(radians(w.latitude))*cos(radians(w.longitude-${input.lng}::double precision)))))`
      : Prisma.sql`NULL::double precision`;
    const score = input.query ? Prisma.sql`ts_rank_cd(doc.document,websearch_to_tsquery('simple',${input.query}))::double precision` : Prisma.sql`0::double precision`;
    if (input.query) filters.push(Prisma.sql`doc.document @@ websearch_to_tsquery('simple',${input.query})`);
    const column = input.sort === 'PRICE' ? Prisma.sql`w.effective_price` : input.sort === 'DISTANCE' ? Prisma.sql`w.distance_km`
      : input.sort === 'RATING' ? Prisma.sql`w.rating` : Prisma.sql`w.score`;
    const ascending = ['PRICE', 'DISTANCE'].includes(input.sort);
    const page = [Prisma.sql`TRUE`];
    if (input.maxDistanceKm !== undefined) page.push(Prisma.sql`w.distance_km<=${input.maxDistanceKm}`);
    if (cursor) {
      const value = input.sort === 'PRICE' || input.sort === 'RATING' ? Prisma.sql`${String(cursor.value)}::numeric` : Prisma.sql`${cursor.value}::double precision`;
      page.push(Prisma.sql`(${column} ${ascending ? Prisma.sql`>` : Prisma.sql`<`} ${value}
        OR (${column}=${value} AND w.id>${cursor.id}))`);
    }
    return prisma.$queryRaw(Prisma.sql`WITH found AS (
      SELECT w.*,TRUE AS is_listed,${distance} AS distance_km,${score} AS score,${effectivePrice} AS effective_price
      FROM public_worker_profiles w LEFT JOIN active_worker_discounts d ON d.worker_id=w.id
        AND (d.expires_at IS NULL OR d.expires_at>statement_timestamp())
      ${input.query ? Prisma.sql`JOIN worker_search_documents doc ON doc.worker_id=w.id` : Prisma.empty}
      WHERE ${Prisma.join(filters, ' AND ')}
    ) ${projection()} FROM found w WHERE ${Prisma.join(page, ' AND ')}
    ORDER BY ${column} ${ascending ? Prisma.sql`ASC` : Prisma.sql`DESC`},w.id ASC LIMIT ${input.limit + 1}`);
  },
  async create(userId, input) {
    return write(async (db) => {
      await accountLock(db, userId);
      if (await db.workerProfile.findUnique({ where: { userId }, select: { id: true } })) throw new AppError('WORKER_PROFILE_EXISTS', 409);
      if ([...input.services, ...input.workingHours.shifts].some((s) => s.id !== undefined)) throw new AppError('INVALID_CHILD_ID', 400);
      await validateTypes(db, input);
      const row = await db.workerProfile.create({ data: { userId, categoryId: input.categoryId, ...profileData(input) } });
      await synchronizeChildren(db, row.id, input);
      return row.id;
    });
  },
  async update(id, userId, input, restore = false) {
    return write(async (db) => {
      const row = await owned(db, id, userId, restore);
      if (idNumber(row.categoryId) !== input.categoryId) throw new AppError('CATEGORY_IMMUTABLE', 409);
      await validateTypes(db, input);
      if (row.deletedAt) await db.workerProfile.update({ where: { id }, data: { deletedAt: null } });
      const rating = row.deletedAt ? (await db.$queryRaw`SELECT COALESCE(round(avg(rating),1),0) AS rating,
        count(*) AS "ratingCount" FROM active_reviews WHERE worker_id=${id}`)[0] : {};
      await db.workerProfile.update({ where: { id }, data: { ...profileData(input),
        ...rating, ...(row.deletedAt ? { currentIdentityDocumentId: null } : {}) } });
      await synchronizeChildren(db, id, input);
    });
  },
  async setDiscount(id, userId, input) {
    return write(async (db) => {
      await owned(db, id, userId);
      await db.workerDiscount.updateMany({ where: { workerId: id, deletedAt: null }, data: { deletedAt: new Date() } });
      await db.$executeRaw`INSERT INTO worker_discounts(worker_id,type,value,currency,unit,title,expires_at)
        VALUES(${id},${input.type}::discount_type,${input.value},${input.currency ?? null},
          ${input.unit ?? null}::price_unit,${input.title ?? null},${input.expiresAt === undefined ? null : new Date(input.expiresAt)})`;
    });
  },
  async removeDiscount(id, userId) {
    return write(async (db) => {
      await owned(db, id, userId);
      await db.workerDiscount.updateMany({ where: { workerId: id, deletedAt: null }, data: { deletedAt: new Date() } });
    });
  },
  async setFlags(id, userId, data) {
    return write(async (db) => { await owned(db, id, userId); await db.workerProfile.update({ where: { id }, data }); });
  },
  async softDelete(id, userId) {
    return write(async (db) => {
      const row = await owned(db, id, userId, true);
      if (!row.deletedAt) await db.workerProfile.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
};
