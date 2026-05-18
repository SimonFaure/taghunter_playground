// Shared retry helper for transient network/5xx failures.
//
// Extracted from syncOrchestrator.ts so launched-games and any other future
// service can wrap writes with the same retry policy.
//
// Policy:
//   - 3 attempts at ~1s/4s/16s with ±25% jitter
//   - retry on: network errors (no response), timeouts, 429, 5xx
//   - permanent on: 4xx other than 429
//   - 401/403 are not retried (a re-request won't change the verdict); they
//     bubble immediately for the caller to interpret — 401 is fatal to the
//     whole operation, 403 is a per-resource "forbidden" the caller may skip.

import { ApiError } from './api';

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const RETRY_JITTER = 0.25;

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err) || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(jitter(RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return false;
    if (err.status === 429 || err.status >= 500) return true;
    return false;
  }
  return true;
}

function jitter(baseMs: number): number {
  const delta = baseMs * RETRY_JITTER;
  return baseMs + (Math.random() * 2 - 1) * delta;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
