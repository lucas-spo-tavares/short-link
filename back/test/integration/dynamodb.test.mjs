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
    const candidates = ['aaaaaa', 'aaaaaa', 'bbbbbb'];
    configureHandlers({ store, log, codeGenerator: () => candidates.shift() });
    assert.equal((await links(post(one.apiKey, 'https://example.com/one'))).statusCode, 201);
    const result = await links(post(one.apiKey, 'https://example.com/two'));
    assert.equal(result.statusCode, 201);
    assert.equal(JSON.parse(result.body).code, 'bbbbbb');
    assert.equal((await links(get('aaaaaa'))).headers.location, 'https://example.com/one');
    const items = await client.send(
      new ScanCommand({ TableName: linksTable, ConsistentRead: true }),
    );
    assert.equal(items.Count, 6);
    configureHandlers({ store, log });
  });

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
      assert.equal((await links(get('aaaaaa'))).statusCode, 302);
      await admin({ action: 'delete', keyId: two.keyId });
      assert.deepEqual(await admin({ action: 'list' }), { items: [] });
    },
  );
});
