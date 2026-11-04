import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createStore } from './store.mjs';

const client = new DynamoDBClient({
  maxAttempts: 2,
  retryMode: 'standard',
  requestHandler: { connectionTimeout: 1500, requestTimeout: 4000 },
});

export function invocationStore() {
  return createStore({
    client,
    linksTable: process.env.LINKS_TABLE,
    keysTable: process.env.KEYS_TABLE,
    abortSignal: AbortSignal.timeout(22000),
  });
}
