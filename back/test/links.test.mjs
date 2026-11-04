import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, get, namedError, post } from './helpers.mjs';
import { generateApiKey, sha256 } from '../src/shared/security.mjs';

test('creates, deduplicates across API keys, and resolves the exact original URL publicly', async () => {
  const f = fixture();
  const url = 'https://example.com/a%2Fb?z=%2B&x=2&x=1#fragment';
  const first = await f.links(post(f.key.apiKey, url));
  assert.equal(first.statusCode, 201);
  const { code, shortUrl, created } = JSON.parse(first.body);
  assert.match(code, /^[a-z]{6}$/);
  assert.equal(created, true);
  assert.equal(shortUrl, `https://link.lucas-tavares.com/${code}`);
  const other = generateApiKey();
  f.store.keys.set(other.keyId, other);
  const repeated = await f.links(post(other.apiKey, url));
  assert.equal(repeated.statusCode, 200);
  assert.equal(JSON.parse(repeated.body).code, code);
  assert.equal(JSON.parse(repeated.body).created, false);
  for (const method of ['GET', 'HEAD']) {
    const event = { ...get(code, method), rawQueryString: 'ignored=true' };
    const result = await f.links(event);
    assert.equal(result.statusCode, 302);
    assert.equal(result.headers.location, url);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.body, '');
  }
  assert.equal(f.store.codes.size, 1);
  assert.equal(f.store.urls.size, 1);
});

test('concurrent identical requests produce one created result and the same code', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 30 }, () => f.links(post(f.key.apiKey))));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 200).length, 29);
  assert.equal(new Set(results.map((r) => JSON.parse(r.body).code)).size, 1);
  assert.equal(f.store.codes.size, 1);
  assert.equal(f.store.urls.size, 1);
});

test('a code collision retries without overwriting the existing destination', async () => {
  const values = ['aaaaaa', 'aaaaaa', 'bbbbbb'];
  const f = fixture({ codeGenerator: () => values.shift() });
  const first = await f.links(post(f.key.apiKey, 'https://example.com/one'));
  const second = await f.links(post(f.key.apiKey, 'https://example.com/two'));
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(JSON.parse(second.body).code, 'bbbbbb');
  assert.equal((await f.links(get('aaaaaa'))).headers.location, 'https://example.com/one');
  assert.equal((await f.links(get('bbbbbb'))).headers.location, 'https://example.com/two');
});

test('textually different URLs get different associations', async () => {
  const f = fixture();
  for (const url of ['https://example.com/?a=1&b=2', 'https://example.com/?b=2&a=1']) {
    assert.equal((await f.links(post(f.key.apiKey, url))).statusCode, 201);
  }
  assert.equal(f.store.urls.size, 2);
});

test('authentication is required even when the URL already exists', async () => {
  const f = fixture();
  const first = await f.links(post(f.key.apiKey));
  const unknown = generateApiKey().apiKey;
  const wrongSecret = `${f.key.apiKey.slice(0, -1)}${f.key.apiKey.endsWith('A') ? 'B' : 'A'}`;
  for (const apiKey of [undefined, '', 'invalid', unknown, wrongSecret]) {
    assert.equal((await f.links(post(apiKey))).statusCode, 401);
  }
  await f.admin({ action: 'delete', keyId: f.key.keyId });
  assert.equal((await f.links(post(f.key.apiKey))).statusCode, 401);
  assert.equal((await f.links(get(JSON.parse(first.body).code))).statusCode, 302);
});

test('invalid input and forbidden destinations do not create items', async () => {
  const f = fixture();
  for (const url of [
    null,
    123,
    '',
    '/relative',
    'ftp://example.com/a',
    'https://',
    'https://example.com/a b',
    'https://example.com/\r\nLocation:evil',
    'https://u:p@example.com/a',
    'https://link.lucas-tavares.com/aaaaaa',
    'https://LINK.LUCAS-TAVARES.COM.:443/aaaaaa',
    'https://example.com/\\a',
    `https://example.com/${'a'.repeat(8192)}`,
  ]) {
    assert.equal((await f.links(post(f.key.apiKey, url))).statusCode, 400, String(url));
  }
  const event = post(f.key.apiKey);
  for (const body of ['bad json', 'null', '[]', '{}']) {
    assert.equal((await f.links({ ...event, body })).statusCode, 400);
  }
  assert.equal((await f.links({ ...event, body: 'a'.repeat(16385) })).statusCode, 413);
  assert.equal(
    (await f.links({ ...event, headers: { 'x-api-key': f.key.apiKey } })).statusCode,
    415,
  );
  assert.equal(f.store.codes.size, 0);
});

test('base64-encoded payloads and mixed-case headers work', async () => {
  const f = fixture();
  const event = post(f.key.apiKey);
  event.headers = { 'X-Api-Key': f.key.apiKey, 'Content-Type': 'application/json; charset=utf-8' };
  event.body = Buffer.from(event.body).toString('base64');
  event.isBase64Encoded = true;
  assert.equal((await f.links(event)).statusCode, 201);
});

test('unknown routes and codes return 404 and HEAD errors have no body', async () => {
  const f = fixture();
  for (const code of ['missing', 'abcdef', 'ABCDEF', '123456', 'abcde', 'api-keys']) {
    assert.equal((await f.links(get(code))).statusCode, 404);
  }
  assert.equal((await f.links({ ...post(f.key.apiKey), rawPath: '/api-keys' })).statusCode, 404);
  assert.equal((await f.links(get('absent', 'HEAD'))).body, '');
});

test('transaction conflicts retry and exhaustion returns 503', async () => {
  const f = fixture();
  let calls = 0;
  f.store.putLink = async () => {
    calls++;
    throw namedError('TransactionCanceledException', {
      CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
    });
  };
  const result = await f.links(post(f.key.apiKey));
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['retry-after'], '1');
  assert.equal(calls, 6);
  assert.equal(f.store.urls.size, 0);
});

test('a lost transaction response reuses the committed code', async () => {
  const f = fixture();
  const put = f.store.putLink;
  f.store.putLink = async (item) => {
    await put(item);
    throw namedError('TimeoutError');
  };
  const result = await f.links(post(f.key.apiKey));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).created, false);
  assert.equal(f.store.codes.size, 1);
});

test('unexpected transaction failures are not treated as code collisions', async () => {
  const f = fixture();
  let calls = 0;
  f.store.putLink = async () => {
    calls++;
    throw namedError('AccessDeniedException');
  };
  assert.equal((await f.links(post(f.key.apiKey))).statusCode, 500);
  assert.equal(calls, 1);
});

test('hash mismatches fail instead of reusing an unrelated code', async () => {
  const f = fixture();
  const url = 'https://example.com/a';
  f.store.urls.set(sha256(url), { url: 'https://example.com/b', code: 'abcdef' });
  assert.equal((await f.links(post(f.key.apiKey, url))).statusCode, 500);
});

test('errors and logs do not expose API keys, URLs or exception details', async () => {
  const f = fixture();
  const url = 'https://example.com/private?secret=do-not-log';
  await f.links(post(f.key.apiKey, url));
  f.store.getKey = async () => {
    throw namedError('ProvisionedThroughputExceededException');
  };
  const result = await f.links(post(f.key.apiKey, url));
  assert.equal(result.statusCode, 503);
  const output = result.body + f.logs.join('\n');
  for (const secret of [url, f.key.apiKey, 'do not expose this detail']) {
    assert.equal(output.includes(secret), false);
  }
});
