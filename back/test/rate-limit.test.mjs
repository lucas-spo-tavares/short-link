import assert from 'node:assert/strict';
import test from 'node:test';
import { transition, rateLimit } from '../src/shared/rate-limit.mjs';
import { memoryStore } from './helpers.mjs';

test('rolling window removes only failures older than a minute; successes do not reset it', () => {
  let state;
  for (const now of [0, 10_000, 20_000, 30_000]) state = transition(state, now, true);
  assert.equal(transition(state, 40_000, false), undefined);
  const fifth = transition(state, 59_999, true);
  assert.equal(fifth.blockedUntil, 89_999);
  const expiredFirst = transition(state, 60_000, true);
  assert.equal(expiredFirst.blockedUntil, 0);
  assert.deepEqual(expiredFirst.failures, [10_000, 20_000, 30_000, 60_000]);
});

test('every blocked attempt escalates and extends the deadline, capped at 15 minutes', () => {
  let state;
  for (let i = 0; i < 5; i++) state = transition(state, i, true);
  assert.equal(state.blockedUntil, 30_004);
  for (const [index, duration] of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000].entries()) {
    const now = 100 + index;
    state = transition(state, now, false);
    assert.equal(state.blockedUntil, now + duration);
  }
  const deadline = state.blockedUntil;
  state = transition(state, deadline + 1, true);
  assert.equal(state.level, 6);
  assert.equal(state.blockedUntil, 0);
  state = transition(state, deadline + 1 + 900_000, true);
  assert.equal(state.level, 0);
  assert.equal(state.failures.length, 1);
});

test('concurrent failures are preserved, isolated by IP, and return Retry-After', async () => {
  const store = memoryStore();
  const clock = () => 1_000;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => rateLimit(store, '192.0.2.1', { failed: true, clock })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
  const blocked = results.find((result) => result.status === 'rejected').reason;
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.retryAfter, 30);
  await assert.rejects(rateLimit(store, '192.0.2.1', { clock }), { retryAfter: 60 });
  await rateLimit(store, '192.0.2.2', { clock });
  assert.equal(store.rates.size, 1);
  assert.equal(JSON.stringify([...store.rates]).includes('192.0.2.1'), false);
  await rateLimit(store, '192.0.2.1', { clock: () => 61_000 });
  // Success leaves the existing record completely untouched.
  assert.equal([...store.rates.values()][0].state.level, 2);
});

test('missing IP and exhausted conditional retries fail with 503', async () => {
  const store = memoryStore();
  await assert.rejects(rateLimit(store, undefined), { statusCode: 503 });
  store.putRateLimit = async () => {
    throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' });
  };
  await assert.rejects(rateLimit(store, '192.0.2.1', { failed: true }), { statusCode: 503 });
});
