import { randomUUID, randomInt } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AppError } from './errors.mjs';
import { sha256 } from './security.mjs';

const windowMs = 60_000;
const resetMs = 15 * 60_000;
const maxPenaltyMs = 15 * 60_000;

// Pure transition: successful requests leave all error history untouched.
export function transition(previous, now, failed) {
  const state =
    previous && now < Math.max(previous.lastFailure, previous.blockedUntil) + resetMs
      ? previous
      : { failures: [], level: 0, blockedUntil: 0, lastFailure: 0 };
  const blocked = state.blockedUntil > now;
  if (!blocked && !failed) return undefined;
  const failures = [...state.failures.filter((time) => time > now - windowMs), now].slice(-5);
  const penalize = blocked || failures.length === 5;
  const level = penalize ? Math.min(state.level + 1, 6) : state.level;
  return {
    failures,
    level,
    lastFailure: now,
    blockedUntil: penalize ? now + Math.min(30_000 * 2 ** (level - 1), maxPenaltyMs) : 0,
  };
}

// Conditional replacement serializes simultaneous attempts across Lambda instances.
// No cleanup job is necessary: old state expires logically and is replaced on use.
export async function rateLimit(store, ip, { failed = false, clock = Date.now } = {}) {
  if (!ip) throw new AppError(503, 'temporarily_unavailable');
  const key = sha256(ip);
  for (let attempt = 0; attempt < 12; attempt++) {
    const previous = await store.getRateLimit(key);
    const now = clock();
    const next = transition(previous?.state, now, failed);
    if (!next) return;
    try {
      await store.putRateLimit(key, { version: randomUUID(), state: next }, previous?.version);
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      await setTimeout(randomInt(5, 30));
      continue;
    }
    if (next.blockedUntil > now) {
      const error = new AppError(429, 'too_many_requests');
      error.retryAfter = Math.ceil((next.blockedUntil - now) / 1000);
      throw error;
    }
    return;
  }
  throw new AppError(503, 'temporarily_unavailable');
}
