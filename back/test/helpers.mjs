import { mock } from 'node:test';
import * as security from '../src/shared/security.mjs';

const { generateApiKey } = security;
let currentStore;
let currentCodeGenerator = security.generateCode;

mock.module('../src/shared/runtime.mjs', {
  namedExports: { invocationStore: () => currentStore },
});
mock.module('../src/shared/security.mjs', {
  namedExports: { ...security, generateCode: () => currentCodeGenerator() },
});
mock.module('node:timers/promises', {
  namedExports: { setTimeout: async () => {} },
});

export const { handler: linksHandler } = await import('../src/links.mjs');
export const { handler: apiKeysHandler } = await import('../src/api-keys.mjs');

export function configureHandlers({ store, log, codeGenerator = security.generateCode }) {
  currentStore = store;
  currentCodeGenerator = codeGenerator;
  process.env.BASE_URL = 'https://link.lucas-tavares.com';
  mock.method(console, 'info', log);
}

export function namedError(name, fields = {}) {
  return Object.assign(new Error('do not expose this detail'), { name, ...fields });
}

export function memoryStore() {
  const keys = new Map();
  const codes = new Map();
  const urls = new Map();
  return {
    keys,
    codes,
    urls,
    async getKey(id) {
      return keys.get(id);
    },
    async getCode(code) {
      return codes.get(code);
    },
    async getUrl(hash) {
      return urls.get(hash);
    },
    async putKey(item) {
      keys.set(item.keyId, { ...item });
    },
    async deleteKey(id) {
      keys.delete(id);
    },
    async listKeys() {
      return [...keys.values()];
    },
    async putLink(item) {
      if (codes.has(item.code) || urls.has(item.hash)) {
        throw namedError('TransactionCanceledException', {
          CancellationReasons: [
            { Code: codes.has(item.code) ? 'ConditionalCheckFailed' : 'None' },
            { Code: urls.has(item.hash) ? 'ConditionalCheckFailed' : 'None' },
          ],
        });
      }
      codes.set(item.code, { ...item });
      urls.set(item.hash, { ...item });
    },
  };
}

export function post(apiKey, url = 'https://example.com/a?b=2&a=1') {
  return {
    rawPath: '/links',
    requestContext: { http: { method: 'POST' }, requestId: 'request-id' },
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  };
}

export function get(code, method = 'GET') {
  return { rawPath: `/${code}`, requestContext: { http: { method } } };
}

export function fixture(options = {}) {
  const store = memoryStore();
  const key = generateApiKey();
  store.keys.set(key.keyId, { ...key, name: 'test', createdAt: '2026-11-04T00:00:00.000Z' });
  const logs = [];
  const log = (message) => logs.push(message);
  configureHandlers({ store, log, ...options });
  return { store, key, logs, links: linksHandler, admin: apiKeysHandler };
}
