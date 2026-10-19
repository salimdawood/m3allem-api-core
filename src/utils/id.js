import { z } from 'zod';

// SQL identities remain BIGINT. JSON IDs are numbers; reject loss of precision.
export const idNumber = (value) => {
  if ((typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') ||
      !/^[1-9]\d*$/.test(String(value))) throw new RangeError('Invalid numeric ID');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('ID exceeds the supported JSON integer range');
  return number;
};
export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const pathIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(idSchema);
export const jsonReplacer = (_key, value) => {
  if (typeof value !== 'bigint') return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('Integer exceeds the supported JSON range');
  return number;
};
