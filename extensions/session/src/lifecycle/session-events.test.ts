import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as store from "../session-store";
import * as workspaceDb from "../workspace-db";
import * as gitStatus from "../git-status";
import { initRuntime, resetRuntime, type SessionRuntime } from "../runtime";
import { emitGitStatus } from "./session-events";

const ROOT = "/repo/emit-git-status";
const WORKTREE = "/repo/emit-git-status.worktrees/feat/chip";

function stored(cwd: string | null): store.StoredSession {
  return {
    id: "ses_emit_git_status",
    workspaceId: "ws_emit_git_status",
    providerSessionId: "ses_emit_git_status",
    model: "test",
    agent: "claude",
    purpose: "chat",
    parentSessionId: null,
    status: "active",
    runtimeStatus: "idle",
    disposition: "open",
    title: null,
    summary: null,
    metadata: null,
    previousSessionId: null,
    cwd,
    lastActivity: "2026-11-02",
    createdAt: "2026-11-02",
    updatedAt: "2026-11-02",
  };
}

describe("emitGitStatus", () => {
  const emit = mock(() => {});
  let spies: Array<{ mockRestore: () => void }> = [];
  let collect: ReturnType<typeof spyOn<typeof gitStatus, "collectGitStatus">>;

  beforeEach(() => {
    emit.mockClear();
    collect = spyOn(gitStatus, "collectGitStatus").mockImplementation(async (cwd) => ({
      cwd,
      branch: "feat/chip",
      detached: false,
      operation: null,
      ahead: 0,
      behind: 0,
      dirty: {
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
        renamed: 0,
        conflicted: 0,
        total: 0,
      },
      pr: null,
    }));
    spies = [
      collect,
      spyOn(workspaceDb, "getWorkspace").mockReturnValue({
        id: "ws_emit_git_status",
        cwd: ROOT,
      } as workspaceDb.Workspace),
      spyOn(store, "updateSessionMetadata").mockImplementation(() => true),
    ];
    initRuntime({
      sessionActors: { getRoutingOptions: () => undefined },
      ctx: { emit },
    } as unknown as SessionRuntime);
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    resetRuntime();
  });

  it("collects git status in the session's own folder, not the workspace root", async () => {
    spies.push(spyOn(store, "getStoredSession").mockReturnValue(stored(WORKTREE)));
    await emitGitStatus("ses_emit_git_status");
    expect(collect).toHaveBeenCalledWith(WORKTREE);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the workspace root for a row with no cwd", async () => {
    spies.push(spyOn(store, "getStoredSession").mockReturnValue(stored(null)));
    await emitGitStatus("ses_emit_git_status");
    expect(collect).toHaveBeenCalledWith(ROOT);
  });
});
