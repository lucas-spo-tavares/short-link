import { randomUUID } from 'node:crypto';
import { AppError, publicError } from './shared/errors.mjs';
import { generateApiKey, keyIdPattern } from './shared/security.mjs';
import { invocationStore } from './shared/runtime.mjs';

export async function handler(event, context = {}) {
  const store = invocationStore();

  const requestId = context.awsRequestId ?? randomUUID();
  let operation = 'unknown';
  let status = 200;
  let result;

  try {
    // This function accepts administrative events only, never HTTP events.
    if (!event || typeof event !== 'object' || event.requestContext || event.httpMethod) {
      throw new AppError(400, 'invalid_action');
    }

    if (event.action === 'create') {
      operation = 'create';
      if (typeof event.name !== 'string' || !event.name.trim() || event.name.trim().length > 100) {
        throw new AppError(400, 'invalid_name');
      }

      const name = event.name.trim();
      const createdAt = new Date().toISOString();
      const { keyId, apiKey, keyHash } = generateApiKey();
      await store.putKey({ keyId, keyHash, name, createdAt });
      result = { keyId, name, createdAt, apiKey };
    } else if (event.action === 'list') {
      operation = 'list';
      const items = await store.listKeys();
      result = { items: items.map(({ keyId, name, createdAt }) => ({ keyId, name, createdAt })) };
    } else if (event.action === 'delete') {
      operation = 'delete';
      if (typeof event.keyId !== 'string' || !keyIdPattern.test(event.keyId)) {
        throw new AppError(400, 'invalid_key_id');
      }
      await store.deleteKey(event.keyId);
      result = { keyId: event.keyId, deleted: true };
    } else {
      throw new AppError(400, 'invalid_action');
    }
  } catch (error) {
    const failure = publicError(error);
    status = failure.statusCode;
    result = { error: failure.code, statusCode: status, requestId };
  }
  console.info(JSON.stringify({ requestId, operation, status }));
  return result;
}
