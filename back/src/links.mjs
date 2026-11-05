import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AppError, isRetryableTransaction, publicError } from './shared/errors.mjs';
import { authenticate, generateCode, sha256 } from './shared/security.mjs';
import {
  isValidCode,
  parseBody,
  validateCode,
  validateUrl,
  validateOptions,
} from './shared/validation.mjs';
import { invocationStore } from './shared/runtime.mjs';
import { rateLimit } from './shared/rate-limit.mjs';

const baseUrl = process.env.BASE_URL;
const maxAttempts = 6;

const existingCode = (item, url) => {
  if (item.url !== url || !/^(?:[a-z]{6}|[a-z0-9]{8})$/.test(item.code)) {
    throw new AppError(500, 'internal_error');
  }
  return item.code;
};

const available = (item, now = Date.now()) =>
  item &&
  (item.expiresAt === undefined || item.expiresAt > now) &&
  (item.maxAccesses === undefined || item.accessCount < item.maxAccesses);

async function createLink(store, url, keyId, options) {
  // Preserve the original URL hash for links with default options, including legacy links.
  const hash = sha256(Object.keys(options).length ? JSON.stringify([url, options]) : url);
  let previous = await store.getUrl(hash);
  const reusable = async (item) => {
    if (!item) return false;
    existingCode(item, url);
    const target = await store.getCode(item.code);
    // Explicit replacements are independent of automatic URL deduplication.
    return target?.version === undefined && available(target);
  };
  if (await reusable(previous)) return { code: previous.code, created: false };

  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateCode();
    try {
      await store.putLink({
        hash,
        code,
        url,
        createdAt,
        createdByKeyId: keyId,
        options,
        previousCode: previous?.code,
      });
      return { code, created: true };
    } catch (error) {
      if (!isRetryableTransaction(error)) throw error;
      // Also handles a successful commit whose response was lost in transit.
      const winner = await store.getUrl(hash);
      if (await reusable(winner)) return { code: winner.code, created: false };
      previous = winner;
      if (attempt + 1 < maxAttempts) {
        await setTimeout(randomInt(Math.min(100 * 2 ** attempt, 1500) + 1));
      }
    }
  }
  throw new AppError(503, 'temporarily_unavailable');
}

async function replaceLink(store, code, url, keyId, options) {
  const version = randomUUID();
  const createdAt = new Date().toISOString();
  let previous = await store.getCode(code);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const takeover = !!previous && previous.createdByKeyId !== keyId;
    if (takeover) {
      if (!previous.createdByKeyId || (await store.getKey(previous.createdByKeyId))) {
        throw new AppError(403, 'forbidden');
      }
    }
    const created = !previous;
    try {
      await store.putCustomLink({
        code,
        url,
        createdAt,
        createdByKeyId: keyId,
        options,
        version,
        previous,
        takeover,
      });
      return { code, created };
    } catch (error) {
      if (!isRetryableTransaction(error)) throw error;
      previous = await store.getCode(code);
      if (previous?.version === version) return { code, created };
      if (attempt + 1 < maxAttempts) {
        await setTimeout(randomInt(Math.min(100 * 2 ** attempt, 1500) + 1));
      }
    }
  }
  throw new AppError(503, 'temporarily_unavailable');
}

export async function handler(event, context = {}) {
  // The store's abort signal belongs to this invocation, not the Lambda instance.
  const store = invocationStore();
  const requestId = context.awsRequestId ?? event?.requestContext?.requestId ?? randomUUID();
  const method = event?.requestContext?.http?.method;
  const path = event?.rawPath;
  const headers = {
    'cache-control': 'no-store',
    'x-request-id': requestId,
  };
  let statusCode;
  let body;
  let operation = 'unknown';

  try {
    if (method === 'POST' && path === '/links') {
      operation = 'create';
      const inputHeaders = Object.fromEntries(
        Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const keyId = await authenticate(inputHeaders['x-api-key'], store);

      if (!/^application\/json(?:\s*;|\s*$)/i.test(inputHeaders['content-type'] ?? '')) {
        throw new AppError(415, 'unsupported_media_type');
      }

      const input = parseBody(event);
      const url = validateUrl(input.url, baseUrl);
      const options = validateOptions(input);
      const code = validateCode(input.code);
      const result =
        code === undefined
          ? await createLink(store, url, keyId, options)
          : await replaceLink(store, code, url, keyId, options);
      statusCode = result.created ? 201 : 200;
      body = JSON.stringify({
        code: result.code,
        shortUrl: `${baseUrl}/${result.code}`,
        created: result.created,
      });
      headers['content-type'] = 'application/json';
    } else if (['GET', 'HEAD'].includes(method) && /^\/[^/]+$/.test(path ?? '')) {
      operation = 'resolve';
      const ip = event.requestContext.http.sourceIp;
      await rateLimit(store, ip);
      const code = path.slice(1);
      const item = isValidCode(code) ? await store.getCode(code) : undefined;
      if (
        !available(item) ||
        (item.maxAccesses !== undefined &&
          !(await store.consumeCode(code, Date.now(), item.version)))
      ) {
        await rateLimit(store, ip, { failed: true });
        throw new AppError(404, 'not_found');
      }
      statusCode = 302;
      headers.location = item.url;
      body = '';
    } else {
      throw new AppError(404, 'not_found');
    }
  } catch (error) {
    const failure = publicError(error);
    statusCode = failure.statusCode;
    headers['content-type'] = 'application/json';
    if (statusCode === 503) headers['retry-after'] = '1';
    if (statusCode === 429) headers['retry-after'] = String(failure.retryAfter);
    body = JSON.stringify({ error: failure.code, requestId });
  }
  console.info(JSON.stringify({ requestId, operation, status: statusCode }));
  return { statusCode, headers, body: method === 'HEAD' ? '' : body };
}
