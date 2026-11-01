import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { notifyTransition, transitionFor } from "./failure-notify";

describe("transitionFor", () => {
  // Outcomes are newest first, the run that just ended included.
  it("reports the first failure by default", () => {
    expect(transitionFor(["error"], 1)).toBe("failed");
    expect(transitionFor(["error", "success"], 1)).toBe("failed");
  });

  it("stays quiet while a task keeps failing", () => {
    expect(transitionFor(["error", "error"], 1)).toBeNull();
    expect(transitionFor(["error", "error", "error"], 2)).toBeNull();
  });

  it("reports recovery, and nothing for a healthy streak", () => {
    expect(transitionFor(["success", "error"], 1)).toBe("recovered");
    expect(transitionFor(["success", "success"], 1)).toBeNull();
    expect(transitionFor(["success"], 1)).toBeNull();
  });

  it("waits for N failures in a row when alertAfter is N", () => {
    expect(transitionFor(["error", "success", "success"], 2)).toBeNull();
    expect(transitionFor(["error", "error", "success"], 2)).toBe("failed");
  });

  it("only reports recovery from a streak that was alerted", () => {
    expect(transitionFor(["success", "error", "success"], 2)).toBeNull();
    expect(transitionFor(["success", "error", "error"], 2)).toBe("recovered");
  });

  it("does not miss a failure when history is short", () => {
    expect(transitionFor(["error", "error"], 2)).toBe("failed");
    expect(transitionFor(["error"], 2)).toBeNull();
  });
});

describe("notifyTransition", () => {
  function ctxWith(onCall: (method: string, params: Record<string, unknown>) => unknown) {
    const warnings: string[] = [];
    const ctx = {
      call: async (method: string, params: Record<string, unknown> = {}) => onCall(method, params),
      log: { info() {}, warn: (m: string) => warnings.push(m), error() {}, debug() {} },
    } as unknown as ExtensionContext;
    return { ctx, warnings };
  }

  it("sends the first line of the error and how to see the rest", async () => {
    const sent: Record<string, unknown>[] = [];
    const { ctx } = ctxWith((_m, p) => sent.push(p));
    await notifyTransition(
      ctx,
      { id: "t1", name: "morning-flight" },
      "failed",
      'Error: Process exited with code 1\nerror: Module not found "flight.ts"',
    );
    expect(sent[0]).toMatchObject({ title: "Task failed", source: "scheduler" });
    expect(String(sent[0]?.message)).toBe(
      'Scheduled task "morning-flight" failed: Process exited with code 1\nanima scheduler get_history --taskId t1',
    );
  });

  it("never throws when notify is unavailable", async () => {
    const { ctx, warnings } = ctxWith(() => {
      throw new Error("Unknown method: notify.send");
    });
    await notifyTransition(ctx, { id: "t1", name: "x" }, "recovered");
    expect(warnings).toEqual(["Could not send task notification"]);
  });
});
