import { describe, expect, test } from "bun:test";
import { groupSubagents, nestSubagents, type ActiveSessionRow } from "./NavigationDrawer";

function row(sessionId: string, parentSessionId: string | null = null): ActiveSessionRow {
  return {
    sessionId,
    workspaceId: "ws",
    workspaceName: "ws",
    title: sessionId,
    firstPrompt: null,
    runtimeStatus: "running",
    disposition: "open",
    waitingSince: "2026-11-02T00:00:00.000Z",
    pinned: false,
    parentSessionId,
  };
}

const ids = (rows: ActiveSessionRow[]) => rows.map((r) => r.sessionId);

describe("nestSubagents", () => {
  test("puts each subagent directly under its parent, siblings in server order", () => {
    // Server order is newest first, so children usually arrive before their parent.
    const rows = [row("1b", "coord"), row("other"), row("1a", "coord"), row("coord")];
    expect(ids(nestSubagents(rows))).toEqual(["other", "coord", "1b", "1a"]);
  });

  test("a subagent whose parent isn't listed keeps its own place", () => {
    const rows = [row("a"), row("orphan", "resolved-parent"), row("b")];
    expect(ids(nestSubagents(rows))).toEqual(["a", "orphan", "b"]);
  });

  test("nests a subagent's own subagents under it", () => {
    const rows = [row("grandchild", "child"), row("child", "root"), row("root")];
    expect(ids(nestSubagents(rows))).toEqual(["root", "child", "grandchild"]);
  });
});

describe("groupSubagents", () => {
  test("folds every descendant under its top-level parent", () => {
    const rows = [row("grandchild", "child"), row("other"), row("child", "root"), row("root")];
    expect(groupSubagents(rows).map((g) => [g.row.sessionId, ids(g.subagents)])).toEqual([
      ["other", []],
      ["root", ["child", "grandchild"]],
    ]);
  });

  test("an orphan subagent is its own top-level row", () => {
    const groups = groupSubagents([row("orphan", "gone")]);
    expect(groups.map((g) => [g.row.sessionId, ids(g.subagents)])).toEqual([["orphan", []]]);
  });
});
