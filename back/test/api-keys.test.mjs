import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, namedError } from './helpers.mjs';
import { sha256 } from '../src/shared/security.mjs';

test('key creation stores only the hash and listing returns all public metadata', async () => {
  const f = fixture();
  const result = await f.admin({ action: 'create', name: ' integration ' });
  assert.equal(result.name, 'integration');
  assert.match(result.apiKey, /^sl_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  const stored = f.store.keys.get(result.keyId);
  assert.equal(stored.keyHash, sha256(result.apiKey));
  assert.equal(stored.apiKey, undefined);
  const listed = await f.admin({ action: 'list' });
  assert.equal(listed.items.length, 2);
  assert.deepEqual(Object.keys(listed), ['items']);
  for (const item of listed.items) {
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'keyId', 'name']);
  }
  assert.equal(f.logs.join('\n').includes(result.apiKey), false);
});

test('deletion is idempotent and the empty listing is an array', async () => {
  const f = fixture();
  const payload = { action: 'delete', keyId: f.key.keyId };
  assert.deepEqual(await f.admin(payload), { keyId: f.key.keyId, deleted: true });
  assert.deepEqual(await f.admin(payload), { keyId: f.key.keyId, deleted: true });
  assert.deepEqual(await f.admin({ action: 'list' }), { items: [] });
});

test('invalid actions, HTTP events, names and identifiers are rejected', async () => {
  const f = fixture();
  const inputs = [
    null,
    {},
    { action: 'invalid' },
    { action: 'list', requestContext: {} },
    { action: 'create' },
    { action: 'create', name: ' ' },
    { action: 'create', name: 'a'.repeat(101) },
    { action: 'delete', keyId: 'invalid' },
  ];
  for (const input of inputs) assert.equal((await f.admin(input)).statusCode, 400);
  assert.equal(f.store.keys.size, 1);
});

test('administrative errors are sanitized', async () => {
  const f = fixture();
  f.store.listKeys = async () => {
    throw namedError('AccessDeniedException');
  };
  const result = await f.admin({ action: 'list' });
  assert.equal(result.statusCode, 500);
  assert.equal(result.error, 'internal_error');
  assert.equal(JSON.stringify(result).includes('do not expose'), false);
});
