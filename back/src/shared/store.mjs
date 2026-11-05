import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';

// Keep DynamoDB types at this boundary; timestamps and counters use numbers.
const encode = (item) =>
  Object.fromEntries(
    Object.entries(item).map(([k, v]) => [k, typeof v === 'number' ? { N: String(v) } : { S: v }]),
  );
const decode = (item) =>
  item
    ? Object.fromEntries(
        Object.entries(item).map(([k, v]) => [k, v.N === undefined ? v.S : Number(v.N)]),
      )
    : undefined;

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
    async getRateLimit(key) {
      const item = await get(linksTable, { pk: `IP#${key}` });
      return item ? { version: item.version, state: JSON.parse(item.state) } : undefined;
    },
    async putRateLimit(key, item, previousVersion) {
      await send(
        new PutItemCommand({
          TableName: linksTable,
          Item: encode({
            pk: `IP#${key}`,
            version: item.version,
            state: JSON.stringify(item.state),
          }),
          ConditionExpression: previousVersion
            ? '#version = :previous'
            : 'attribute_not_exists(pk)',
          ...(previousVersion
            ? {
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: encode({ ':previous': previousVersion }),
              }
            : {}),
        }),
      );
    },
    async consumeCode(code, now, version) {
      try {
        await send(
          new TransactWriteItemsCommand({
            // Reusing this token for SDK retries prevents double consumption.
            ClientRequestToken: randomUUID(),
            TransactItems: [
              {
                Update: {
                  TableName: linksTable,
                  Key: encode({ pk: `CODE#${code}` }),
                  UpdateExpression: 'ADD accessCount :one',
                  ConditionExpression:
                    'attribute_exists(pk) AND (attribute_not_exists(expiresAt) OR expiresAt > :now) AND accessCount < maxAccesses AND ' +
                    (version === undefined
                      ? 'attribute_not_exists(#version)'
                      : '#version = :version'),
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: encode({
                    ':one': 1,
                    ':now': now,
                    ...(version === undefined ? {} : { ':version': version }),
                  }),
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (
          error.name === 'TransactionCanceledException' &&
          error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
        )
          return false;
        throw error;
      }
    },
    async putCustomLink({
      code,
      url,
      createdAt,
      createdByKeyId,
      options,
      version,
      previous,
      takeover = false,
    }) {
      await send(
        new TransactWriteItemsCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            {
              Put: {
                TableName: linksTable,
                Item: encode({
                  pk: `CODE#${code}`,
                  url,
                  createdAt,
                  createdByKeyId,
                  ...options,
                  version,
                  ...(options.maxAccesses === undefined ? {} : { accessCount: 0 }),
                }),
                ConditionExpression: !previous
                  ? 'attribute_not_exists(pk)'
                  : previous.version === undefined
                    ? 'createdByKeyId = :owner AND attribute_not_exists(#version)'
                    : 'createdByKeyId = :owner AND #version = :previous',
                ...(previous ? { ExpressionAttributeNames: { '#version': 'version' } } : {}),
                ...(previous
                  ? {
                      ExpressionAttributeValues: encode({
                        ':owner': takeover ? previous.createdByKeyId : createdByKeyId,
                        ...(previous.version === undefined
                          ? {}
                          : { ':previous': previous.version }),
                      }),
                    }
                  : {}),
              },
            },
            ...(takeover
              ? [
                  {
                    ConditionCheck: {
                      TableName: keysTable,
                      Key: encode({ keyId: previous.createdByKeyId }),
                      ConditionExpression: 'attribute_not_exists(keyId)',
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    },
    async putLink({ hash, code, url, createdAt, createdByKeyId, options = {}, previousCode }) {
      const items = [
        {
          pk: `CODE#${code}`,
          url,
          createdAt,
          createdByKeyId,
          ...options,
          ...(options.maxAccesses === undefined ? {} : { accessCount: 0 }),
        },
        { pk: `URL#${hash}`, url, code, createdAt },
      ];
      await send(
        new TransactWriteItemsCommand({
          // SDK retries of this exact request cannot create ambiguous duplicate writes.
          ClientRequestToken: randomUUID(),
          TransactItems: items.map((item, index) => ({
            Put: {
              TableName: linksTable,
              Item: encode(item),
              ConditionExpression:
                index === 1 && previousCode ? 'code = :previous' : 'attribute_not_exists(pk)',
              ...(index === 1 && previousCode
                ? {
                    ExpressionAttributeValues: encode({ ':previous': previousCode }),
                  }
                : {}),
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
