import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { createStore } from '../../src/shared/store.mjs';
import { rateLimit } from '../../src/shared/rate-limit.mjs';
import {
  apiKeysHandler as admin,
  configureHandlers,
  get,
  linksHandler as links,
  post,
} from '../helpers.mjs';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(endpoint)) {
  throw new Error(
    'Defina DYNAMODB_ENDPOINT=http://127.0.0.1:8000 para usar apenas DynamoDB Local.',
  );
}

test('real DynamoDB transactions, concurrency, collisions, key lifecycle and redirects', async (t) => {
  const client = new DynamoDBClient({
    endpoint,
    region: 'sa-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 3,
  });
  const suffix = randomUUID();
  const linksTable = `short-link-test-links-${suffix}`;
  const keysTable = `short-link-test-keys-${suffix}`;
  const tables = [];
  t.after(async () => {
    for (const TableName of tables) await client.send(new DeleteTableCommand({ TableName }));
    client.destroy();
  });
  for (const [TableName, key] of [
    [linksTable, 'pk'],
    [keysTable, 'keyId'],
  ]) {
    await client.send(
      new CreateTableCommand({
        TableName,
        KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      }),
    );
    tables.push(TableName);
  }
  const store = createStore({ client, linksTable, keysTable });
  const log = () => {};
  configureHandlers({ store, log });
  const one = await admin({ action: 'create', name: 'one' });
  const two = await admin({ action: 'create', name: 'two' });
  assert.ok(one.apiKey);
  assert.ok(two.apiKey);

  await t.test(
    'simultaneous identical creates across keys produce exactly two database items',
    async () => {
      const url = 'https://example.com/a%2Fb?token=a%2Bb&z=2&z=1';
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => links(post(i % 2 ? one.apiKey : two.apiKey, url))),
      );
      assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
      assert.equal(results.filter((r) => r.statusCode === 200).length, 19);
      const codes = new Set(results.map((r) => JSON.parse(r.body).code));
      assert.equal(codes.size, 1);
      const [code] = codes;
      assert.equal((await links(get(code))).headers.location, url);
      assert.equal((await links(get(code, 'HEAD'))).body, '');
      const items = await client.send(
        new ScanCommand({ TableName: linksTable, ConsistentRead: true }),
      );
      assert.equal(items.Count, 2);
    },
  );

  await t.test('a collision leaves the old association intact', async () => {
    const candidates = ['aaaaaa01', 'aaaaaa01', 'bbbbbb02'];
    configureHandlers({ store, log, codeGenerator: () => candidates.shift() });
    assert.equal((await links(post(one.apiKey, 'https://example.com/one'))).statusCode, 201);
    const result = await links(post(one.apiKey, 'https://example.com/two'));
    assert.equal(result.statusCode, 201);
    assert.equal(JSON.parse(result.body).code, 'bbbbbb02');
    assert.equal((await links(get('aaaaaa01'))).headers.location, 'https://example.com/one');
    const items = await client.send(
      new ScanCommand({ TableName: linksTable, ConsistentRead: true }),
    );
    assert.equal(items.Count, 6);
    configureHandlers({ store, log });
  });

  await t.test(
    'limited links use numeric counters and only one concurrent caller consumes the last access',
    async () => {
      const event = post(one.apiKey);
      event.body = JSON.stringify({
        url: 'https://example.com/once',
        maxAccesses: 1,
        expiresAt: '2099-01-01T00:00:00Z',
      });
      const created = await links(event);
      assert.equal(created.statusCode, 201);
      const { code } = JSON.parse(created.body);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) => {
          const request = get(code, index === 0 ? 'HEAD' : 'GET');
          request.requestContext.http.sourceIp = `192.0.2.${index + 20}`;
          return links(request);
        }),
      );
      assert.equal(results.filter((result) => result.statusCode === 302).length, 1);
      assert.equal(results.filter((result) => result.statusCode === 404).length, 3);
      const stored = await store.getCode(code);
      assert.equal(stored.accessCount, 1);
      assert.equal(stored.maxAccesses, 1);
      assert.equal(stored.expiresAt, Date.parse('2099-01-01T00:00:00Z'));
      const replacement = await links(event);
      assert.equal(replacement.statusCode, 201);
      assert.notEqual(JSON.parse(replacement.body).code, code);
      assert.equal(
        await store.consumeCode(
          JSON.parse(replacement.body).code,
          Date.parse('2099-01-01T00:00:00Z'),
        ),
        false,
      );
    },
  );

  await t.test(
    'custom codes replace atomically without reusing stale URL associations',
    async () => {
      const create = (code, url, options = {}) => {
        const event = post(one.apiKey, url);
        event.body = JSON.stringify({ url, code, ...options });
        return links(event);
      };
      const oldUrl = 'https://example.com/before-replacement';
      const auto = JSON.parse((await links(post(one.apiKey, oldUrl))).body).code;
      assert.equal((await create(auto, 'https://example.com/replaced')).statusCode, 200);
      const recreated = await links(post(one.apiKey, oldUrl));
      assert.equal(recreated.statusCode, 201);
      assert.notEqual(JSON.parse(recreated.body).code, auto);
      assert.equal((await links(get(auto))).headers.location, 'https://example.com/replaced');

      const first = await create('fixed-link', oldUrl, { maxAccesses: 1 });
      assert.equal(first.statusCode, 201);
      const unauthorized = post(two.apiKey);
      unauthorized.body = JSON.stringify({ code: 'fixed-link', url: 'https://example.com/denied' });
      assert.equal((await links(unauthorized)).statusCode, 403);
      const before = await store.getCode('fixed-link');
      await assert.rejects(
        store.putCustomLink({
          code: 'fixed-link',
          url: 'https://example.com/denied',
          createdAt: new Date().toISOString(),
          createdByKeyId: two.keyId,
          options: {},
          version: randomUUID(),
          previous: before,
        }),
        { name: 'TransactionCanceledException' },
      );
      assert.deepEqual(await store.getCode('fixed-link'), before);
      const version = (await store.getCode('fixed-link')).version;
      assert.equal((await links(get('fixed-link'))).statusCode, 302);
      assert.equal(
        (await create('fixed-link', 'https://example.com/new', { maxAccesses: 1 })).statusCode,
        200,
      );
      assert.equal(await store.consumeCode('fixed-link', Date.now(), version), false);
      assert.equal((await links(get('fixed-link'))).headers.location, 'https://example.com/new');
      assert.equal((await create('fixed-link', oldUrl)).statusCode, 200);
      const stored = await store.getCode('fixed-link');
      assert.equal(stored.maxAccesses, undefined);
      assert.equal(stored.accessCount, undefined);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          create('concurrent-fixed', `https://example.com/concurrent/${index}`, {
            maxAccesses: index + 1,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
      assert.equal(results.filter((r) => r.statusCode === 200).length, 3);
      const final = await store.getCode('concurrent-fixed');
      assert.equal(final.maxAccesses, Number(final.url.slice(-1)) + 1);
      assert.equal(final.accessCount, 0);
    },
  );

  await t.test('takeovers require a deleted key and transfer ownership atomically', async () => {
    const owner = await admin({ action: 'create', name: 'temporary-owner' });
    for (const expired of [false, true]) {
      const code = expired ? 'expired-takeover' : 'active-takeover';
      await store.putCustomLink({
        code,
        url: 'https://example.com/old',
        createdAt: new Date().toISOString(),
        createdByKeyId: owner.keyId,
        options: expired ? { expiresAt: Date.now() - 1 } : {},
        version: randomUUID(),
      });
      const previous = await store.getCode(code);
      const write = {
        code,
        url: 'https://example.com/new',
        createdAt: new Date().toISOString(),
        createdByKeyId: two.keyId,
        options: {},
        version: randomUUID(),
        previous,
        takeover: true,
      };
      // Even a caller bypassing the handler cannot assume a code with a live owner.
      await assert.rejects(store.putCustomLink(write), { name: 'TransactionCanceledException' });
    }
    await admin({ action: 'delete', keyId: owner.keyId });
    for (const code of ['expired-takeover', 'active-takeover']) {
      const event = post(two.apiKey);
      event.body = JSON.stringify({ url: 'https://example.com/new', code });
      assert.equal((await links(event)).statusCode, 200);
      assert.equal((await store.getCode(code)).createdByKeyId, two.keyId);
      assert.equal((await links(get(code))).headers.location, 'https://example.com/new');
      event.headers['x-api-key'] = one.apiKey;
      assert.equal((await links(event)).statusCode, 403);
    }
  });

  await t.test(
    'conditional IP state preserves concurrent failures and blocked attempts escalate',
    async () => {
      const options = { failed: true, clock: () => 1_000 };
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => rateLimit(store, '192.0.2.100', options)),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
      const blocked = results.find((result) => result.status === 'rejected').reason;
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.retryAfter, 30);
      await assert.rejects(rateLimit(store, '192.0.2.100', { clock: () => 2_000 }), {
        retryAfter: 60,
      });
      await rateLimit(store, '192.0.2.100', { clock: () => 62_000 });
    },
  );

  await t.test(
    'all key metadata is returned without hashes; revocation preserves links',
    async () => {
      const listed = await admin({ action: 'list' });
      assert.equal(listed.items.length, 2);
      assert.deepEqual(Object.keys(listed), ['items']);
      assert.equal(JSON.stringify(listed).includes('keyHash'), false);
      const raw = await client.send(
        new ScanCommand({ TableName: keysTable, ConsistentRead: true }),
      );
      assert.equal(JSON.stringify(raw.Items).includes(one.apiKey), false);
      await admin({ action: 'delete', keyId: one.keyId });
      assert.equal((await links(post(one.apiKey, 'https://example.com/one'))).statusCode, 401);
      assert.equal((await links(post(two.apiKey, 'https://example.com/one'))).statusCode, 200);
      assert.equal((await links(get('aaaaaa01'))).statusCode, 302);
      await admin({ action: 'delete', keyId: two.keyId });
      assert.deepEqual(await admin({ action: 'list' }), { items: [] });
    },
  );
});
