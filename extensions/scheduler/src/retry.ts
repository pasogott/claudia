/**
 * Retry a failed run before it counts as failed.
 *
 * A blip (wifi dropping out, a cloud API timing out once) shouldn't text
 * Michael. A task with `retries > 0` gets that many extra attempts inside the
 * same execution, waiting `retryDelaySeconds` before the first and doubling
 * each time after (10s, 20s, 40s, …, capped at MAX_DELAY_MS). Only the last
 * attempt's error is recorded, and only that one can notify.
 */

/** No single wait longer than this, however many retries a task asks for. */
export const MAX_DELAY_MS = 10 * 60_000;

/** Wait before retry number `retry` (1-based): base, 2×base, 4×base, … */
export function retryDelayMs(retry: number, baseSeconds: number): number {
  return Math.min(baseSeconds * 1000 * 2 ** (retry - 1), MAX_DELAY_MS);
}

/** Put "(attempt N of M)" on the error's first line, which is what the notification shows. */
export function withAttempts(error: string, attempts: number): string {
  if (attempts <= 1) return error;
  const [first = "", ...rest] = error.split("\n");
  return [`${first} (attempt ${attempts} of ${attempts})`, ...rest].join("\n");
}

export interface RetryHooks {
  /** Called after a failed attempt that will be retried. */
  onRetry: (info: { attempt: number; attempts: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `attempt` up to `1 + retries` times. Resolves with the first success and
 * how many attempts it took; rejects with the last error, its first line
 * marked with the attempt count.
 */
export async function runWithRetries<T>(
  attempt: () => Promise<T>,
  retries: number,
  retryDelaySeconds: number,
  hooks: RetryHooks,
): Promise<{ result: T; attempts: number }> {
  const attempts = 1 + Math.max(0, retries);
  const sleep = hooks.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let n = 1; ; n++) {
    try {
      return { result: await attempt(), attempts: n };
    } catch (error) {
      if (n >= attempts) throw new Error(withAttempts(errorText(error), attempts));
      const delayMs = retryDelayMs(n, retryDelaySeconds);
      hooks.onRetry({ attempt: n, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
}
