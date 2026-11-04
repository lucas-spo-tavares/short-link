import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AppError, isRetryableTransaction, publicError } from './shared/errors.mjs';
import { authenticate, generateCode, sha256 } from './shared/security.mjs';
import { parseBody, validateUrl } from './shared/validation.mjs';
import { invocationStore } from './shared/runtime.mjs';

const store = invocationStore();
const baseUrl = process.env.BASE_URL;
const maxAttempts = 6;

const existingCode = (item, url) => {
  if (item.url !== url || !/^[a-z]{6}$/.test(item.code)) {
    throw new AppError(500, 'internal_error');
  }
  return item.code;
};

async function createLink(url, keyId) {
  const hash = sha256(url);
  const previous = await store.getUrl(hash);

  if (previous) {
    return {
      code: existingCode(previous, url),
      created: false,
    };
  }

  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateCode();
    try {
      await store.putLink({ hash, code, url, createdAt, createdByKeyId: keyId });
      return { code, created: true };
    } catch (error) {
      if (!isRetryableTransaction(error)) throw error;
      // Also handles a successful commit whose response was lost in transit.
      const winner = await store.getUrl(hash);
      if (winner) return { code: existingCode(winner, url), created: false };
      if (attempt + 1 < maxAttempts) {
        await setTimeout(randomInt(Math.min(100 * 2 ** attempt, 1500) + 1));
      }
    }
  }
  throw new AppError(503, 'temporarily_unavailable');
}

export async function handler(event, context = {}) {
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

      const url = validateUrl(parseBody(event).url, baseUrl);
      const result = await createLink(url, keyId);
      statusCode = result.created ? 201 : 200;
      body = JSON.stringify({
        code: result.code,
        shortUrl: `${baseUrl}/${result.code}`,
        created: result.created,
      });
      headers['content-type'] = 'application/json';
    } else if (['GET', 'HEAD'].includes(method) && /^\/[a-z]{6}$/.test(path ?? '')) {
      operation = 'resolve';
      const item = await store.getCode(path.slice(1));
      if (!item) throw new AppError(404, 'not_found');
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
    body = JSON.stringify({ error: failure.code, requestId });
  }
  console.info(JSON.stringify({ requestId, operation, status: statusCode }));
  return { statusCode, headers, body: method === 'HEAD' ? '' : body };
}
