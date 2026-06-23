// Shared transient-error retry for the structured AI extractors (bank / arap /
// suggest-journal / detect-bundle). The main extractIntent path already retries;
// these did not, so a single transient Anthropic API error (429 / 5xx / overload /
// network blip) silently dropped a document. Same policy as claude.ts.

const MAX_ATTEMPTS = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A transient API condition worth retrying: rate limit (429), overload (529),
 *  5xx, or a network/timeout blip. */
export function isTransient(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; name?: string; message?: string };
  const s = e?.status ?? e?.statusCode;
  if (s === 429 || s === 500 || s === 502 || s === 503 || s === 529) return true;
  const name = e?.name || '';
  const msg = (e?.message || '').toLowerCase();
  if (/overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|socket hang|network|fetch failed|internal server error/.test(msg)) return true;
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError';
}

/** Exponential backoff (ms) by 0-indexed attempt. Deterministic — no randomness. */
function backoffMs(attempt: number): number {
  return [1500, 4000, 9000, 18000][Math.min(attempt, 3)];
}

export interface RetryOpts {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Run `fn`, retrying transient failures with backoff. Non-transient errors are
 *  rethrown immediately. Throws the last error if all attempts fail. */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  const max = opts?.maxAttempts ?? MAX_ATTEMPTS;
  const sleepFn = opts?.sleep ?? sleep;
  let lastErr: unknown = new Error('retry: no attempts');
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isTransient(err) && attempt < max - 1) {
        await sleepFn(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
