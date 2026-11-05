import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';

export const keyIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyPattern = /^sl_([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export function generateApiKey() {
  const keyId = randomUUID();
  const apiKey = `sl_${keyId}.${randomBytes(32).toString('base64url')}`;
  return { keyId, apiKey, keyHash: sha256(apiKey) };
}

export async function authenticate(apiKey, store) {
  const match = typeof apiKey === 'string' ? keyPattern.exec(apiKey) : null;
  if (!match || !keyIdPattern.test(match[1])) throw new AppError(401, 'unauthorized');
  const item = await store.getKey(match[1]);
  const actual = Buffer.from(sha256(apiKey), 'hex');
  // Always compare equal-size buffers, including for an unknown identifier.
  const validHash = /^[0-9a-f]{64}$/.test(item?.keyHash ?? '');
  const expected = validHash ? Buffer.from(item.keyHash, 'hex') : Buffer.alloc(32);
  const matches = timingSafeEqual(actual, expected);
  if (!validHash || !matches) throw new AppError(401, 'unauthorized');
  return item.keyId;
}
