import { describe, expect, test } from "bun:test";
import { subagentSummary } from "./SubagentActivityStrip";
import type { SubagentInfo } from "../hooks/useChatGateway";

const sub = (status: SubagentInfo["status"]): SubagentInfo => ({
  subagentId: `${status}-${Math.random()}`,
  parentSessionId: "p",
  agent: "claude",
  purpose: "subagent",
  status,
});

describe("subagentSummary", () => {
  test("counts the busy ones first and leaves out empty groups", () => {
    const all = [sub("completed"), sub("running"), sub("completed"), sub("failed"), sub("running")];
    expect(subagentSummary(all)).toBe("2 running · 1 failed · 2 done");
  });

  test("a single finished subagent", () => {
    expect(subagentSummary([sub("completed")])).toBe("1 done");
  });
});
