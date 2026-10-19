import { catalogRepository } from './catalog.repository.js';
import { createHash } from 'node:crypto';
import { jsonReplacer } from '../../utils/id.js';

// Respect preference weights and regional tags; fall back to English.
export const catalogLanguage = (header = 'en') => String(header).split(',').map((part, index) => {
  const [tag, ...parameters] = part.trim().toLowerCase().split(';');
  const q = parameters.find((value) => value.trim().startsWith('q='));
  const weight = q === undefined ? 1 : Number(q.trim().slice(2));
  return { language: tag.split('-')[0], weight, index };
}).filter((item) => ['en', 'fr', 'ar'].includes(item.language) && item.weight > 0 && item.weight <= 1)
  .sort((a, b) => b.weight - a.weight || a.index - b.index)[0]?.language ?? 'en';

export const catalogService = {
  getCatalog: (header) => catalogRepository.snapshot(catalogLanguage(header)),
  async catalogResponse(header, ifNoneMatch) {
    const data = await this.getCatalog(header);
    const etag = `"${createHash('sha256').update(JSON.stringify(data, jsonReplacer)).digest('hex')}"`;
    const headers = { ETag: etag, Vary: 'Accept-Language', 'Cache-Control': 'public, max-age=0, must-revalidate' };
    const matched = String(ifNoneMatch ?? '').split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*');
    return matched ? { statusCode: 304, headers } : { headers, data };
  },
  async getBanners(header) {
    return { headers: { Vary: 'Accept-Language', 'Cache-Control': 'no-cache' },
      data: await catalogRepository.banners(catalogLanguage(header)) };
  }
};
