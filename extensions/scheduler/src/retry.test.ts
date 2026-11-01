import { describe, expect, it } from "bun:test";
import { MAX_DELAY_MS, retryDelayMs, runWithRetries, withAttempts } from "./retry";

describe("retryDelayMs", () => {
  it("doubles from the base delay", () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, 10))).toEqual([10_000, 20_000, 40_000, 80_000]);
  });

  it("never waits longer than the cap", () => {
    expect(retryDelayMs(20, 10)).toBe(MAX_DELAY_MS);
  });
});

describe("withAttempts", () => {
  it("marks the first line, which is what the notification shows", () => {
    expect(withAttempts("Process exited with code 1\nstderr line", 4)).toBe(
      "Process exited with code 1 (attempt 4 of 4)\nstderr line",
    );
  });

  it("leaves a single attempt alone", () => {
    expect(withAttempts("Process timed out after 15000ms", 1)).toBe(
      "Process timed out after 15000ms",
    );
  });
});

describe("runWithRetries", () => {
  function recorder() {
    const waits: number[] = [];
    const retried: number[] = [];
    return {
      waits,
      retried,
      hooks: {
        sleep: async (ms: number) => void waits.push(ms),
        onRetry: ({ attempt }: { attempt: number }) => void retried.push(attempt),
      },
    };
  }

  function failTimes(times: number) {
    let calls = 0;
    return async () => {
      calls++;
      if (calls <= times) throw new Error(`Process timed out after 15000ms`);
      return "ok";
    };
  }

  it("recovers from a blip without failing", async () => {
    const r = recorder();
    const out = await runWithRetries(failTimes(2), 3, 10, r.hooks);
    expect(out).toEqual({ result: "ok", attempts: 3 });
    expect(r.waits).toEqual([10_000, 20_000]);
    expect(r.retried).toEqual([1, 2]);
  });

  it("fails with the last error once every attempt is used", async () => {
    const r = recorder();
    const run = runWithRetries(failTimes(99), 3, 10, r.hooks);
    await expect(run).rejects.toThrow("Process timed out after 15000ms (attempt 4 of 4)");
    expect(r.waits).toEqual([10_000, 20_000, 40_000]);
  });

  it("runs once and keeps the plain error when retries is 0", async () => {
    const r = recorder();
    const run = runWithRetries(failTimes(99), 0, 10, r.hooks);
    await expect(run).rejects.toThrow(/^Process timed out after 15000ms$/);
    expect(r.waits).toEqual([]);
  });
});
