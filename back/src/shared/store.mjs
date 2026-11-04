import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';

// All stored fields are strings. Keep the SDK wire format at this boundary.
const encode = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, { S: v }]));
const decode = (item) =>
  item ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v.S])) : undefined;

export function createStore({ client, linksTable, keysTable, abortSignal }) {
  const send = (command) => client.send(command, { abortSignal });
  const get = async (TableName, key) => {
    const result = await send(
      new GetItemCommand({ TableName, Key: encode(key), ConsistentRead: true }),
    );
    return decode(result.Item);
  };
  return {
    getKey: (keyId) => get(keysTable, { keyId }),
    getCode: (code) => get(linksTable, { pk: `CODE#${code}` }),
    getUrl: (hash) => get(linksTable, { pk: `URL#${hash}` }),
    async putLink({ hash, code, url, createdAt, createdByKeyId }) {
      const items = [
        { pk: `CODE#${code}`, url, createdAt, createdByKeyId },
        { pk: `URL#${hash}`, url, code, createdAt },
      ];
      await send(
        new TransactWriteItemsCommand({
          // SDK retries of this exact request cannot create ambiguous duplicate writes.
          ClientRequestToken: randomUUID(),
          TransactItems: items.map((item) => ({
            Put: {
              TableName: linksTable,
              Item: encode(item),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          })),
        }),
      );
    },
    async putKey(item) {
      await send(
        new PutItemCommand({
          TableName: keysTable,
          Item: encode(item),
          ConditionExpression: 'attribute_not_exists(keyId)',
        }),
      );
    },
    async listKeys() {
      const items = [];
      let cursor;
      do {
        const page = await send(
          new ScanCommand({
            TableName: keysTable,
            ProjectionExpression: 'keyId, #name, createdAt',
            ExpressionAttributeNames: { '#name': 'name' },
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        items.push(...(page.Items ?? []).map(decode));
        cursor = page.LastEvaluatedKey;
      } while (cursor && Object.keys(cursor).length);
      return items;
    },
    async deleteKey(keyId) {
      await send(new DeleteItemCommand({ TableName: keysTable, Key: encode({ keyId }) }));
    },
  };
}
