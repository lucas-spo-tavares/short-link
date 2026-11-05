import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Use the real runtime setup, including its timeout, without contacting DynamoDB.
mock.module('../src/shared/store.mjs', {
  namedExports: {
    createStore: ({ abortSignal }) => ({
      async getRateLimit() {},
      async getCode() {
        abortSignal.throwIfAborted();
        return { url: 'https://example.com/destination' };
      },
    }),
  },
});

test('warm Lambda invocations get fresh DynamoDB timeouts after earlier signals expire', async (t) => {
  const controllers = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 22000);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  t.mock.method(console, 'info', () => {});
  const { handler } = await import('../src/links.mjs');

  for (const method of ['GET', 'GET', 'HEAD']) {
    const response = await handler({
      rawPath: '/abcdef',
      requestContext: { http: { method, sourceIp: '192.0.2.1' } },
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://example.com/destination');
    assert.equal(response.body, '');
    // Simulate the previous invocation's 22-second budget expiring.
    controllers.at(-1).abort();
  }
  assert.equal(controllers.length, 3);
});
