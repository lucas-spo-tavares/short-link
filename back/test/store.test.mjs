import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../src/shared/store.mjs';

test('administrative listing collects every DynamoDB page without exposing a cursor', async () => {
  const commands = [];
  const cursor = { keyId: { S: 'first' } };
  const client = {
    async send(command) {
      commands.push(command);
      if (commands.length === 1) return { Items: [], LastEvaluatedKey: cursor };
      return {
        Items: [{ keyId: { S: 'last' }, name: { S: 'integration' }, createdAt: { S: 'date' } }],
      };
    },
  };
  const store = createStore({ client, keysTable: 'keys' });
  assert.deepEqual(await store.listKeys(), [
    { keyId: 'last', name: 'integration', createdAt: 'date' },
  ]);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].input.ExclusiveStartKey, cursor);
  assert.equal(commands[0].input.ProjectionExpression.includes('keyHash'), false);
});
