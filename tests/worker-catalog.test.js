import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const database = `m3allem_worker_test_${Date.now()}`;
const bin = process.env.POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin';
const root = fileURLToPath(new URL('../', import.meta.url));
function pg(executable, args) {
  const result = spawnSync(join(bin, executable), ['-h', '127.0.0.1', '-p', '55436', '-U', 'schema_test', ...args],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '', PGDATABASE: 'postgres' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('catalog and worker routes against finalized SQL', async (t) => {
  pg('createdb', [database]);
  for (const file of ['schema.sql', 'validation/fixture.sql']) pg('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database,
    '-f', join(root, 'database', file)]);
  const connection = `postgresql://schema_test@127.0.0.1:55436/${database}`;
  Object.assign(process.env, { DATABASE_URL: connection, DATABASE_URL_UNPOOLED: connection, NODE_ENV: 'test', APP_ENV: 'staging',
    JWT_ACCESS_SECRET: 'local-test-access-secret-32-characters-only', OTP_HMAC_SECRET: 'local-test-otp-secret-32-characters-only',
    OTP_FIXED_CODE: '111111', OTP_RATE_LIMIT_MAX: '10000', RATE_LIMIT_REDIS_URL: '', LOG_LEVEL: 'silent',
    PRISMA_QUERY_ENGINE_LIBRARY: join(root, 'node_modules/@prisma/engines/query_engine-windows.dll.node') });
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/config/database.js');
  const { signAccessToken } = await import('../src/utils/jwt.js');
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  async function request(method, path, body, token, status = 200, headers = {}) {
    const response = await fetch(base + path, { method, headers: { ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return { data, headers: response.headers };
  }
  const api = async (...args) => (await request(...args)).data;
  const ids = Object.fromEntries((await prisma.$queryRaw`SELECT name,id FROM schema_tests.ids`).map((r) => [r.name, Number(r.id)]));
  async function session(userId) {
    const row = await prisma.authSession.create({ data: { userId, expiresAt: new Date(Date.now() + 86400000) } });
    return signAccessToken(userId, row.id);
  }
  async function verify(workerId, userId) {
    await prisma.$transaction(async (db) => {
      const upload = (await db.$queryRaw`INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
        VALUES(${userId},'IDENTITY_DOCUMENT','private-test',${`worker-${workerId}-${Date.now()}.pdf`}) RETURNING id`)[0];
      await db.$executeRaw`UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=100,
        sha256=decode(repeat('ab',32),'hex') WHERE id=${upload.id}`;
      const doc = (await db.$queryRaw`INSERT INTO identity_documents(worker_id,type,upload_id)
        VALUES(${workerId},'PASSPORT',${upload.id}) RETURNING id`)[0];
      await db.$executeRaw`UPDATE identity_documents SET status='VERIFIED',reviewed_by=${ids.admin} WHERE id=${doc.id}`;
    });
  }
  const customer = await session(ids.customer);
  const owner = await session(ids.owner);
  const outsider = await session(ids.outsider);
  const draft = {
    publicPhoneNumber: '70123456', categoryId: ids.category, workerTypeIds: [ids.worker_type], description: 'Precision repair',
    experienceYears: 3, services: [{ name: 'Specialized fitting', price: null }],
    startingPrice: { amount: 100, unit: 'PER_JOB', currency: 'USD' },
    workingHours: { timeZone: 'Asia/Beirut', shifts: [
      { isoWeekday: 1, opensAt: '08:00', closesAt: '12:00', endDayOffset: 0 },
      { isoWeekday: 1, opensAt: '13:00', closesAt: '17:00', endDayOffset: 0 },
      { isoWeekday: 7, opensAt: '22:00', closesAt: '02:00', endDayOffset: 1 }
    ] }, location: { latitude: 33.89, longitude: 35.5 }, isAvailable: true, isListed: true
  };
  let created;
  let phoneSequence = 210;
  async function extraWorker(startingPrice, description = 'Additional specialist') {
    const user = await prisma.user.create({ data: { phoneNumber: `+96170000${phoneSequence++}`, fullName: description } });
    const token = await session(user.id);
    const worker = await api('POST', '/workers', { ...draft, startingPrice, description }, token, 201);
    await verify(worker.id, Number(user.id));
    return { worker, token, userId: Number(user.id) };
  }
  try {
    await t.test('catalog has numeric IDs, stable slugs, weighted language fallback and ETags', async () => {
      await prisma.categoryTranslation.create({ data: { categoryId: ids.category, language: 'fr', name: 'Entretien', description: 'Travaux' } });
      const first = await request('GET', '/catalog', undefined, undefined, 200, { 'accept-language': 'ar;q=0,fr-LB;q=0.9,en;q=0.5' });
      assert.equal(first.data.categories.find((c) => c.id === ids.category).name, 'Entretien');
      assert.equal(first.data.categories[0].slug, 'home_maintenance');
      assert.equal(typeof first.data.workerTypes[0].categoryId, 'number');
      assert.equal(first.headers.get('vary'), 'Accept-Language');
      await request('GET', '/catalog', undefined, undefined, 304, { 'accept-language': 'fr', 'if-none-match': `W/${first.headers.get('etag')}, "other"` });
      await prisma.categoryTranslation.update({ where: { categoryId_language: { categoryId: ids.category, language: 'fr' } }, data: { deletedAt: new Date() } });
      const next = await request('GET', '/catalog', undefined, undefined, 200, { 'accept-language': 'fr', 'if-none-match': first.headers.get('etag') });
      assert.equal(next.data.categories.find((c) => c.id === ids.category).name, 'Home & Maintenance');
    });
    await t.test('any account can create a profile; unverified profiles stay private', async () => {
      created = await api('POST', '/workers', draft, outsider, 201);
      assert.equal(created.userId, ids.outsider);
      assert.equal(created.fullName, 'Fixture outsider');
      assert.equal(created.publicPhoneNumber, '+96170123456');
      assert.equal(created.verificationStatus, 'NOT_SUBMITTED');
      assert.equal(typeof created.services[0].id, 'number');
      assert.equal(created.services[0].price, null);
      assert.equal(created.workingHours.shifts.length, 3);
      await api('GET', `/workers/${created.id}`, undefined, outsider, 404);
      assert.equal((await api('GET', '/me/worker', undefined, outsider)).id, created.id);
      await api('POST', '/workers', draft, outsider, 409);
      await api('POST', '/workers', { ...draft, role: 'WORKER' }, customer, 400);
      await verify(created.id, ids.outsider);
      assert.equal((await api('GET', `/workers/${created.id}`, undefined, customer)).id, created.id);
    });
    await t.test('profile writes require the current owner and active catalog assignments', async () => {
      await api('PUT', `/workers/${created.id}`, draft, customer, 403);
      const education = await prisma.category.findUnique({ where: { slug: 'education' } });
      await api('PUT', `/workers/${created.id}`, { ...draft, categoryId: Number(education.id) }, outsider, 409);
      await api('PUT', `/workers/${created.id}`, { ...draft, workerTypeIds: [ids.worker_type, ids.worker_type] }, outsider, 400);
      await api('PUT', `/workers/${created.id}`, { ...draft, categoryId: 'home_maintenance' }, outsider, 400);
      await api('PUT', `/workers/${created.id}`, { ...draft, fullName: 'Duplicated name' }, outsider, 400);
      const tutor = await prisma.workerType.findUnique({ where: { slug: 'tutor' } });
      await api('PUT', `/workers/${created.id}`, { ...draft, workerTypeIds: [Number(tutor.id)] }, outsider, 400);
    });
    await t.test('edits preserve child IDs and retain removed rows for restoration', async () => {
      const service = created.services[0];
      const shifts = created.workingHours.shifts;
      const edit = { ...draft, services: [{ ...service, name: 'Retained fitting' }], workingHours: { ...draft.workingHours, shifts } };
      const changed = await api('PUT', `/workers/${created.id}`, edit, outsider);
      assert.equal(changed.services[0].id, service.id);
      assert.deepEqual(changed.workingHours.shifts.map((h) => h.id), shifts.map((h) => h.id));
      await api('PUT', `/workers/${created.id}`, { ...edit, services: [], workingHours: { ...draft.workingHours, shifts: [] } }, outsider);
      assert.ok((await prisma.workerService.findUnique({ where: { id: service.id } })).deletedAt);
      const restored = await api('PUT', `/workers/${created.id}`, edit, outsider);
      assert.equal(restored.services[0].id, service.id);
      await api('PUT', `/workers/${created.id}`, { ...edit, services: [{ ...service, id: 999999 }] }, outsider, 400);
      created = restored;
    });
    await t.test('split, overnight and 24-hour schedules reject overlaps including weekly wrap', async () => {
      const update = (shifts) => ({ ...draft, services: created.services, workingHours: { timeZone: 'Asia/Beirut', shifts } });
      await api('PUT', `/workers/${created.id}`, update([
        { isoWeekday: 7, opensAt: '22:00', closesAt: '02:00', endDayOffset: 1 },
        { isoWeekday: 1, opensAt: '01:00', closesAt: '03:00', endDayOffset: 0 }
      ]), outsider, 400);
      const fullDay = await api('PUT', `/workers/${created.id}`, update([
        { isoWeekday: 2, opensAt: '00:00', closesAt: '00:00', endDayOffset: 1 }
      ]), outsider);
      assert.equal(fullDay.workingHours.shifts[0].endDayOffset, 1);
      await api('PUT', `/workers/${created.id}`, { ...draft, workingHours: { timeZone: 'Mars/Unknown', shifts: [] } }, outsider, 400);
      await api('PUT', `/workers/${created.id}`, draft, outsider);
    });
    await t.test('worker type order defines primary and removed links restore their retained key', async () => {
      const plumber = await prisma.workerType.findUnique({ where: { slug: 'plumber' } });
      const types = [Number(plumber.id), ids.worker_type];
      await api('PUT', `/workers/${created.id}`, { ...draft, workerTypeIds: types }, outsider);
      await api('PUT', `/workers/${created.id}`, draft, outsider);
      assert.ok((await prisma.workerWorkerType.findUnique({ where: { workerId_workerTypeId: { workerId: created.id, workerTypeId: plumber.id } } })).deletedAt);
      const restored = await api('PUT', `/workers/${created.id}`, { ...draft, workerTypeIds: types }, outsider);
      assert.deepEqual(restored.workerTypeIds, types);
    });
    await t.test('discount limits include free results and preserve removed discount history', async () => {
      let row = await api('PUT', `/workers/${ids.worker}/discount`, { type: 'PERCENTAGE', value: 100 }, owner);
      assert.equal(row.effectiveStartingPrice.amount, 0);
      const oldId = row.discount.id;
      row = await api('PUT', `/workers/${ids.worker}/discount`, { type: 'FIXED_AMOUNT', value: 50, currency: 'USD', unit: 'PER_JOB' }, owner);
      assert.equal(row.effectiveStartingPrice.amount, 0);
      assert.ok((await prisma.workerDiscount.findUnique({ where: { id: oldId } })).deletedAt);
      await api('PUT', `/workers/${ids.worker}/discount`, { type: 'FIXED_AMOUNT', value: 51, currency: 'USD', unit: 'PER_JOB' }, owner, 400);
      await api('PUT', `/workers/${ids.worker}/discount`, { type: 'FIXED_AMOUNT', value: 5, currency: 'EUR', unit: 'PER_JOB' }, owner, 400);
      await api('PUT', `/workers/${ids.worker}/discount`, { type: 'PERCENTAGE', value: 101 }, owner, 400);
      await api('DELETE', `/workers/${ids.worker}/discount`, undefined, owner);
      assert.equal((await api('GET', `/workers/${ids.worker}`, undefined, customer)).discount, null);
    });
    await t.test('zero is free, null is quote-required and precision is validated', async () => {
      const free = await extraWorker({ amount: 0, unit: 'PER_JOB', currency: 'USD' }, 'Free specialist');
      const quote = await extraWorker(null, 'Quote specialist');
      assert.equal(free.worker.startingPrice.amount, 0);
      assert.equal(quote.worker.startingPrice, null);
      await api('PUT', `/workers/${free.worker.id}/discount`, { type: 'PERCENTAGE', value: 10 }, free.token, 400);
      await api('PUT', `/workers/${free.worker.id}`, { ...draft, services: [created.services[0]] }, free.token, 400);
      await api('PUT', `/workers/${created.id}`, { ...draft, startingPrice: { amount: 1.001, currency: 'USD', unit: 'PER_JOB' } }, outsider, 400);
    });
    await t.test('discounted prices drive search, and invalid price edits roll back completely', async () => {
      const before = await api('GET', '/me/worker', undefined, outsider);
      const body = { ...draft, workerTypeIds: before.workerTypeIds, services: before.services, workingHours: before.workingHours };
      await api('PUT', `/workers/${created.id}/discount`, { type: 'FIXED_AMOUNT', value: 10, currency: 'USD', unit: 'PER_JOB' }, outsider);
      await api('PUT', `/workers/${created.id}`, { ...body, description: 'Should roll back', startingPrice: null }, outsider, 400);
      assert.equal((await api('GET', '/me/worker', undefined, outsider)).description, before.description);
      const result = await api('GET', '/workers?discountOnly=true&sort=PRICE&currency=USD&priceUnit=PER_JOB', undefined, customer);
      assert.deepEqual(result.items.map((w) => w.id), [created.id]);
      assert.equal(result.items[0].effectiveStartingPrice.amount, 90);
      await api('PUT', `/workers/${created.id}/discount`, { type: 'FIXED_AMOUNT', value: 5, currency: 'USD', unit: 'PER_HOUR' }, outsider, 400);
      await api('DELETE', `/workers/${created.id}/discount`, undefined, outsider);
    });
    await t.test('search, filters and nearby use current public sources', async () => {
      const list = await api('GET', '/workers?query=Retained', undefined, customer);
      assert.equal(list.items.length, 0); // Subsequent replacement removed that service.
      await api('PATCH', '/me', { fullName: 'Unique Searchable Artisan' }, outsider);
      const result = await api('GET', '/workers?query=Searchable', undefined, customer);
      assert.equal(result.items[0].id, created.id);
      assert.equal(result.items[0].fullName, 'Unique Searchable Artisan');
      assert.equal((await api('GET', `/workers?workerTypeId=${ids.worker_type}`, undefined, customer)).items.length >= 2, true);
      const nearby = await api('GET', '/workers/nearby?lat=33.89&lng=35.5&radiusKm=1&limit=1', undefined, customer);
      assert.equal(nearby.length, 1);
      assert.ok(nearby[0].distanceKm < 0.001);
      await api('GET', '/workers?availableOnly=garbage', undefined, customer, 400);
      await api('GET', '/workers?sort=DISTANCE', undefined, customer, 400);
      await api('GET', '/workers?maxDistanceKm=10', undefined, customer, 400);
    });
    await t.test('price sorting compares only matching currency/unit and keyset pages are stable', async () => {
      await extraWorker({ amount: 25, currency: 'USD', unit: 'PER_JOB' });
      await extraWorker({ amount: 1, currency: 'EUR', unit: 'PER_JOB' });
      await extraWorker({ amount: 1, currency: 'USD', unit: 'PER_HOUR' });
      await api('GET', '/workers?sort=PRICE', undefined, customer, 400);
      for (const query of ['sort=PRICE&currency=USD&priceUnit=PER_JOB', 'sort=RATING', 'sort=DISTANCE&lat=33.89&lng=35.5', 'sort=RELEVANCE', 'sort=RELEVANCE&query=specialist']) {
        const all = (await api('GET', `/workers?${query}`, undefined, customer)).items;
        const paged = [];
        let cursor;
        do {
          const page = await api('GET', `/workers?${query}&limit=1${cursor ? `&cursor=${cursor}` : ''}`, undefined, customer);
          paged.push(...page.items);
          cursor = page.nextCursor;
          assert.ok(paged.length <= all.length);
        } while (cursor);
        assert.deepEqual(paged.map((w) => w.id), all.map((w) => w.id));
        if (query.startsWith('sort=PRICE')) assert.deepEqual(all.map((w) => w.startingPrice.amount), [0, 25, 50, 100]);
      }
      const first = await api('GET', '/workers?limit=1', undefined, customer);
      await api('GET', `/workers?limit=1&sort=RATING&cursor=${first.nextCursor}`, undefined, customer, 400);
      await api('GET', '/workers?cursor=garbage', undefined, customer, 400);
    });
    await t.test('listing, availability and catalog deactivation control discovery', async () => {
      await api('PUT', `/workers/${created.id}/availability`, { isAvailable: false }, outsider);
      assert.equal((await api('GET', `/workers/${created.id}`, undefined, customer)).isAvailable, false);
      assert.equal((await api('GET', '/workers?availableOnly=true', undefined, customer)).items.some((w) => w.id === created.id), false);
      await api('PUT', `/workers/${created.id}/listing`, { isListed: false }, outsider);
      await api('GET', `/workers/${created.id}`, undefined, customer, 404);
      assert.equal((await api('GET', '/me/worker', undefined, outsider)).isListed, false);
      await api('PUT', `/workers/${created.id}/listing`, { isListed: true }, outsider);
      await prisma.category.update({ where: { id: ids.category }, data: { isActive: false } });
      assert.equal((await api('GET', '/catalog')).workerTypes.some((w) => w.categoryId === ids.category), false);
      await api('GET', `/workers/${created.id}`, undefined, customer, 404);
      await prisma.category.update({ where: { id: ids.category }, data: { isActive: true } });
    });
    await t.test('favorites share the worker representation and exclude tombstoned favorites', async () => {
      await api('PUT', `/me/favorites/${created.id}`, {}, customer, 204);
      const result = await api('GET', '/workers?favoritesOnly=true', undefined, customer);
      assert.deepEqual(result.items.map((w) => w.id), [created.id]);
      assert.equal(result.items[0].isFavorite, true);
      const expanded = await api('GET', '/me/favorites/workers', undefined, customer);
      assert.equal(expanded[0].publicPhoneNumber, '+96170123456');
      assert.equal(Object.hasOwn(expanded[0], 'phoneNumber'), false);
      await api('DELETE', `/me/favorites/${created.id}`, undefined, customer, 204);
      assert.equal((await api('GET', '/workers?favoritesOnly=true', undefined, customer)).items.length, 0);
    });
    await t.test('concurrent first-profile creation leaves one profile and a complete set of children', async () => {
      const user = await prisma.user.create({ data: { phoneNumber: '+96170000999', fullName: 'Concurrent creator' } });
      const token = await session(user.id);
      const responses = await Promise.all([1, 2].map(() => fetch(base + '/workers', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(draft) })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
      assert.equal(await prisma.workerProfile.count({ where: { userId: user.id } }), 1);
      assert.equal((await api('GET', '/me/worker', undefined, token)).workingHours.shifts.length, 3);
    });
    await t.test('banners respect schedule, category visibility and locale fallback', async () => {
      const make = (title, language, extra = {}) => prisma.promoBanner.create({ data: { title, subtitle: '', language, iconKey: 'home', ...extra } });
      await make('English default', 'en');
      const french = await make('French choice', 'fr', { categoryId: ids.category });
      await make('Future banner', 'fr', { startsAt: new Date(Date.now() + 60000) });
      await make('Ended banner', 'fr', { endsAt: new Date(Date.now() - 60000) });
      assert.deepEqual((await api('GET', '/catalog/banners', undefined, undefined, 200, { 'accept-language': 'fr-LB' })).map((b) => b.id), [Number(french.id)]);
      await prisma.promoBanner.update({ where: { id: french.id }, data: { deletedAt: new Date() } });
      assert.deepEqual((await api('GET', '/catalog/banners', undefined, undefined, 200, { 'accept-language': 'fr' })).map((b) => b.title), ['English default']);
    });
    await t.test('profile soft deletion retains children; restore requires new verification', async () => {
      const previous = await api('GET', '/me/worker', undefined, outsider);
      const body = { ...draft, workerTypeIds: previous.workerTypeIds, services: previous.services, workingHours: previous.workingHours };
      await api('DELETE', `/workers/${created.id}`, undefined, outsider, 204);
      await api('GET', `/workers/${created.id}`, undefined, customer, 404);
      await api('GET', '/me/worker', undefined, outsider, 404);
      assert.ok((await prisma.workerProfile.findUnique({ where: { id: created.id } })).deletedAt);
      assert.ok((await prisma.workerService.findUnique({ where: { id: previous.services[0].id } })).deletedAt);
      await api('POST', '/workers', draft, outsider, 409);
      const restored = await api('POST', `/workers/${created.id}/restore`, body, outsider);
      assert.equal(restored.id, created.id);
      assert.equal(restored.services[0].id, previous.services[0].id);
      assert.equal(restored.verificationStatus, 'NOT_SUBMITTED');
      await api('GET', `/workers/${created.id}`, undefined, customer, 404);
    });
    console.log(`Validated isolated database: ${database}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
