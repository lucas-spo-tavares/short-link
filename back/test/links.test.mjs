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
  assert.match(code, /^[a-z0-9]{8}$/);
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
  const values = ['aaaaaa01', 'aaaaaa01', 'bbbbbb02'];
  const f = fixture({ codeGenerator: () => values.shift() });
  const first = await f.links(post(f.key.apiKey, 'https://example.com/one'));
  const second = await f.links(post(f.key.apiKey, 'https://example.com/two'));
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(JSON.parse(second.body).code, 'bbbbbb02');
  assert.equal((await f.links(get('aaaaaa01'))).headers.location, 'https://example.com/one');
  assert.equal((await f.links(get('bbbbbb02'))).headers.location, 'https://example.com/two');
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
    'https://link.lucas-tavares.com/aaaaaa01',
    'https://LINK.LUCAS-TAVARES.COM.:443/aaaaaa01',
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
  for (const [index, code] of [
    'missing',
    'abcdef',
    'ABCDEF',
    '123456',
    'abcde',
    'api-keys',
  ].entries()) {
    const event = get(code);
    event.requestContext.http.sourceIp = `192.0.2.${index + 2}`;
    assert.equal((await f.links(event)).statusCode, 404);
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

test('options validate strictly and distinguish otherwise identical URLs', async () => {
  const f = fixture();
  const create = (options) => {
    const event = post(f.key.apiKey);
    event.body = JSON.stringify({ ...JSON.parse(event.body), ...options });
    return f.links(event);
  };
  for (const options of [
    { maxAccesses: 0 },
    { maxAccesses: -1 },
    { maxAccesses: 1.5 },
    { maxAccesses: '1' },
    { maxAccesses: null },
    { maxAccesses: 2 ** 53 },
    { expiresAt: null },
    { expiresAt: 'invalid' },
    { expiresAt: 123 },
    { expiresAt: '2020-01-01T00:00:00Z' },
    { expiresAt: '2099-02-30T00:00:00Z' },
  ])
    assert.equal((await create(options)).statusCode, 400, JSON.stringify(options));
  const ordinary = await create({});
  const limited = await create({ maxAccesses: 1 });
  const expiring = await create({ expiresAt: '2099-01-01T00:00:00Z' });
  assert.equal(limited.statusCode, 201);
  assert.equal(expiring.statusCode, 201);
  assert.equal((await create({ maxAccesses: 1 })).statusCode, 200);
  assert.equal((await create({ expiresAt: '2099-01-01T00:00:00.000Z' })).statusCode, 200);
  assert.equal(new Set([ordinary, limited, expiring].map((r) => JSON.parse(r.body).code)).size, 3);
});

test('only one simultaneous request can consume a single-use link; exhausted links can be recreated', async () => {
  const f = fixture();
  const event = post(f.key.apiKey);
  event.body = JSON.stringify({ url: 'https://example.com/once', maxAccesses: 1 });
  const code = JSON.parse((await f.links(event)).body).code;
  const results = await Promise.all(['GET', 'HEAD'].map((method) => f.links(get(code, method))));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [302, 404]);
  const replacement = await f.links(event);
  assert.equal(replacement.statusCode, 201);
  assert.notEqual(JSON.parse(replacement.body).code, code);
  assert.equal((await f.links(get(code))).statusCode, 404);
});

test('expiration is enforced at the exact deadline without deleting the stored link', async (t) => {
  const f = fixture();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const event = post(f.key.apiKey);
  event.body = JSON.stringify({
    url: 'https://example.com/expiring',
    expiresAt: new Date(now + 1000).toISOString(),
  });
  const code = JSON.parse((await f.links(event)).body).code;
  assert.equal((await f.links(get(code))).statusCode, 302);
  Date.now.mock.mockImplementation(() => now + 1000);
  assert.equal((await f.links(get(code))).statusCode, 404);
  assert.equal(f.store.codes.size, 1);
});

test('successful redirects preserve failures; blocked requests escalate even with valid codes and spoofed headers', async (t) => {
  const f = fixture();
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const code = JSON.parse((await f.links(post(f.key.apiKey))).body).code;
  for (let i = 0; i < 4; i++) {
    assert.equal((await f.links(get('absent00'))).statusCode, 404);
    assert.equal((await f.links(get(code))).statusCode, 302);
  }
  const fifth = await f.links(get('absent00'));
  assert.equal(fifth.statusCode, 429);
  assert.equal(fifth.headers['retry-after'], '30');
  const blocked = await f.links({
    ...get(code, 'HEAD'),
    headers: { 'x-forwarded-for': '192.0.2.99' },
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(blocked.body, '');
  now += 60_001;
  assert.equal((await f.links(get(code))).statusCode, 302);
  for (let i = 0; i < 4; i++) assert.equal((await f.links(get('absent00'))).statusCode, 404);
  assert.equal((await f.links(get('absent00'))).headers['retry-after'], '120');
});

test('storage failures do not count as IP errors; legacy links continue to resolve', async () => {
  const f = fixture();
  f.store.codes.set('abcdef', { url: 'https://example.com/legacy' });
  assert.equal((await f.links(get('abcdef'))).statusCode, 302);
  f.store.getCode = async () => {
    throw namedError('ProvisionedThroughputExceededException');
  };
  assert.equal((await f.links(get('absent00'))).statusCode, 503);
  assert.equal(f.store.rates.size, 0);
});

test('explicit codes only allow the creator to replace destinations, reset options and bypass URL deduplication', async () => {
  const f = fixture();
  const create = (code, url, options = {}, apiKey = f.key.apiKey) => {
    const event = post(apiKey, url);
    event.body = JSON.stringify({ url, code, ...options });
    return f.links(event);
  };
  const url = 'https://example.com/original';
  const auto = JSON.parse((await f.links(post(f.key.apiKey, url))).body).code;
  const first = await create('fixed-link_1', url, { maxAccesses: 1 });
  assert.equal(first.statusCode, 201);
  assert.equal(JSON.parse(first.body).code, 'fixed-link_1');
  assert.equal((await f.links(get('fixed-link_1'))).headers.location, url);
  assert.equal((await f.links(get('fixed-link_1'))).statusCode, 404);
  const other = generateApiKey();
  f.store.keys.set(other.keyId, other);
  const before = structuredClone(f.store.codes.get('fixed-link_1'));
  const denied = await create('fixed-link_1', 'https://example.com/new', {}, other.apiKey);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(f.store.codes.get('fixed-link_1'), before);
  const replaced = await create('fixed-link_1', 'https://example.com/new');
  assert.equal(replaced.statusCode, 200);
  assert.equal(JSON.parse(replaced.body).created, false);
  assert.equal(f.store.codes.get('fixed-link_1').maxAccesses, undefined);
  for (const method of ['GET', 'HEAD']) {
    assert.equal(
      (await f.links(get('fixed-link_1', method))).headers.location,
      'https://example.com/new',
    );
  }
  assert.equal((await f.links(get(auto))).headers.location, url);
  // Replacing an automatic code must never make its former URL reuse the new destination.
  assert.equal((await create(auto, 'https://example.com/replacement')).statusCode, 200);
  const recreated = await f.links(post(f.key.apiKey, url));
  assert.equal(recreated.statusCode, 201);
  const newCode = JSON.parse(recreated.body).code;
  assert.notEqual(newCode, auto);
  assert.equal((await f.links(get(newCode))).headers.location, url);
  assert.equal((await create('fixed-link_1', url, { maxAccesses: 1 })).statusCode, 200);
  assert.equal((await f.links(get('fixed-link_1'))).statusCode, 302);
  assert.equal((await create('fixed-link_1', url, { maxAccesses: 1 })).statusCode, 200);
  assert.equal((await f.links(get('fixed-link_1'))).statusCode, 302);
});

test('explicit codes validate strictly and require authentication before replacement', async () => {
  const f = fixture();
  for (const code of [
    null,
    123,
    '',
    'UPPER',
    '-start',
    '_start',
    'a/b',
    'a b',
    'á',
    'a'.repeat(65),
  ]) {
    const event = post(f.key.apiKey);
    event.body = JSON.stringify({ ...JSON.parse(event.body), code });
    const result = await f.links(event);
    assert.equal(result.statusCode, 400, String(code));
    assert.equal(JSON.parse(result.body).error, 'invalid_code');
  }
  for (const code of ['a', 'a'.repeat(64), 'abcdef']) {
    const event = post(f.key.apiKey);
    event.body = JSON.stringify({ ...JSON.parse(event.body), code });
    assert.equal((await f.links(event)).statusCode, 201);
    assert.equal((await f.links(get(code))).statusCode, 302);
    assert.equal(
      (await f.links({ ...event, headers: { 'content-type': 'application/json' } })).statusCode,
      401,
    );
  }
});

test('concurrent replacements keep one complete record and recover lost write responses', async () => {
  const f = fixture();
  const event = post(f.key.apiKey);
  event.body = JSON.stringify({ url: 'https://example.com/custom', code: 'fixed', maxAccesses: 1 });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.links(event)));
  assert.equal(results.filter((result) => result.statusCode === 201).length, 1);
  assert.equal(results.filter((result) => result.statusCode === 200).length, 3);
  assert.equal(f.store.codes.size, 1);
  assert.equal(f.store.urls.size, 0);
  const oldVersion = f.store.codes.get('fixed').version;
  const put = f.store.putCustomLink;
  f.store.putCustomLink = async (item) => {
    await put(item);
    throw namedError('TimeoutError');
  };
  assert.equal((await f.links(event)).statusCode, 200);
  assert.equal(await f.store.consumeCode('fixed', Date.now(), oldVersion), false);
  assert.equal((await f.links(get('fixed'))).statusCode, 302);
});

test('ownership is checked after a concurrent creation and on automatic codes', async () => {
  const f = fixture();
  const other = generateApiKey();
  f.store.keys.set(other.keyId, other);
  const created = await f.links(post(f.key.apiKey));
  const code = JSON.parse(created.body).code;
  const event = post(other.apiKey, 'https://example.com/unauthorized');
  event.body = JSON.stringify({ url: 'https://example.com/unauthorized', code });
  assert.equal((await f.links(event)).statusCode, 403);
  const original = structuredClone(f.store.codes.get(code));
  assert.equal(original.createdByKeyId, f.key.keyId);
  // A new code may be claimed by another key between the read and conditional write.
  event.body = JSON.stringify({ url: 'https://example.com/unauthorized', code: 'race' });
  f.store.putCustomLink = async () => {
    f.store.codes.set('race', { ...original, version: 'winner' });
    throw namedError('TransactionCanceledException', {
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
  };
  assert.equal((await f.links(event)).statusCode, 403);
  assert.equal(f.store.codes.get('race').createdByKeyId, f.key.keyId);
  assert.equal(f.store.codes.get('race').url, original.url);
});

test('deleted owners release active and expired codes; a takeover transfers ownership', async () => {
  for (const expired of [false, true]) {
    const f = fixture();
    const other = generateApiKey();
    const third = generateApiKey();
    f.store.keys.set(other.keyId, other);
    f.store.keys.set(third.keyId, third);
    const event = post(f.key.apiKey);
    event.body = JSON.stringify({ url: 'https://example.com/original', code: 'fixed' });
    await f.links(event);
    if (expired) f.store.codes.get('fixed').expiresAt = Date.now() - 1;
    // The owner can replace even an expired code.
    assert.equal((await f.links(event)).statusCode, 200);
    if (expired) f.store.codes.get('fixed').expiresAt = Date.now() - 1;
    const update = {
      ...event,
      headers: { ...event.headers, 'x-api-key': other.apiKey },
      body: JSON.stringify({ url: 'https://example.com/new', code: 'fixed' }),
    };
    assert.equal((await f.links(update)).statusCode, 403);
    await f.admin({ action: 'delete', keyId: f.key.keyId });
    assert.equal((await f.links(update)).statusCode, 200);
    assert.equal(f.store.codes.get('fixed').createdByKeyId, other.keyId);
    assert.equal((await f.links(get('fixed'))).headers.location, 'https://example.com/new');
    assert.equal(
      (await f.links({ ...update, headers: { ...update.headers, 'x-api-key': third.apiKey } }))
        .statusCode,
      403,
    );
    assert.equal((await f.links(event)).statusCode, 401);
  }
});
