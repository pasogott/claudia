import { describe, expect, test } from "bun:test";
import {
  buildHandoffPrompt,
  handOffSession,
  type HandoffCaller,
  type HandoffDeps,
  type HandoffEventPayload,
} from "./session-handoff";
import type { DraftSessionParams } from "./session-create";
import { handoffSchema } from "../session-methods";

const CALLER: HandoffCaller = {
  id: "old-1",
  workspaceId: "ws-1",
  agent: "claude",
  model: "claude-opus-5-5",
  title: "M6: ENT-753",
  metadata: { bootstrapEffort: "high", bootstrapThinking: true },
};

function recordingDeps(caller: HandoffCaller | null = CALLER) {
  const calls: string[] = [];
  const drafts: DraftSessionParams[] = [];
  const prompts: Array<Record<string, unknown>> = [];
  const files: string[] = [];
  const handedOff: Array<[string, string]> = [];
  const announced: HandoffEventPayload[] = [];
  const worktrees: Array<Record<string, unknown>> = [];
  let failPrompt = false;
  const deps: HandoffDeps = {
    getSession: (id) => (caller && id === caller.id ? caller : null),
    getWorkspaceCwd: (workspaceId) => (workspaceId === "ws-1" ? "/repo" : null),
    getProfile: () => "yolo",
    readFile: (path) => {
      files.push(path);
      return "prompt from file\n";
    },
    createDraft: (params) => {
      calls.push("create");
      drafts.push(params);
      return {
        sessionId: "new-1",
        workspaceId: "ws-1",
        agent: params.agent ?? "claude",
        model: params.model ?? "default-model",
      };
    },
    setTitle: () => {
      calls.push("title");
    },
    sendPrompt: async (params) => {
      calls.push("prompt");
      prompts.push(params);
      if (failPrompt) throw new Error("agent-host down");
    },
    markHandedOff: (sessionId, target) => {
      calls.push("mark");
      handedOff.push([sessionId, target]);
    },
    announce: (payload) => {
      calls.push("announce");
      announced.push(payload);
    },
    createWorktree: async (request) => {
      calls.push("worktree");
      worktrees.push(request);
      return { path: `${request.folder}.worktrees/${request.branch}` };
    },
  };
  return {
    deps,
    calls,
    drafts,
    prompts,
    files,
    handedOff,
    announced,
    worktrees,
    failNextPrompt: () => {
      failPrompt = true;
    },
  };
}

describe("handOffSession", () => {
  test("creates, names, prompts, then links and announces, in that order", async () => {
    const r = recordingDeps();
    const result = await handOffSession(
      { sessionId: "old-1", title: "M7: ENT-754", prompt: "Read NOTES.md, then continue." },
      r.deps,
    );

    expect(r.calls).toEqual(["create", "title", "prompt", "mark", "announce"]);
    expect(r.handedOff).toEqual([["old-1", "new-1"]]);
    expect(r.announced).toEqual([
      {
        sessionId: "old-1",
        targetSessionId: "new-1",
        workspaceId: "ws-1",
        cwd: "/repo",
        title: "M7: ENT-754",
      },
    ]);
    expect(result).toEqual({
      sessionId: "new-1",
      previousSessionId: "old-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      title: "M7: ENT-754",
      agent: "claude",
      model: "claude-opus-5-5",
      profile: "yolo",
      status: "running",
    });
  });

  test("inherits the caller's folder, agent, model, profile and bootstrap settings", async () => {
    const r = recordingDeps();
    await handOffSession({ sessionId: "old-1", title: "t", prompt: "p" }, r.deps);
    expect(r.drafts[0]).toEqual({
      cwd: "/repo",
      agent: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      thinking: true,
      systemPrompt: undefined,
      profile: "yolo",
      previousSessionId: "old-1",
    });
  });

  test("explicit model, profile and targetCwd win over the caller's", async () => {
    const r = recordingDeps();
    await handOffSession(
      {
        sessionId: "old-1",
        title: "t",
        prompt: "p",
        model: "claude-sonnet",
        profile: "auto",
        targetCwd: "/other",
      },
      r.deps,
    );
    expect(r.drafts[0]).toMatchObject({ cwd: "/other", model: "claude-sonnet", profile: "auto" });
    expect(r.prompts[0]).toMatchObject({ cwd: "/other" });
  });

  test("reads a relative prompt file from the caller's folder, even with targetCwd", async () => {
    const r = recordingDeps();
    await handOffSession(
      { sessionId: "old-1", title: "t", promptFile: "tmp/handoff.md", targetCwd: "/other" },
      r.deps,
    );
    expect(r.files).toEqual(["/repo/tmp/handoff.md"]);
    expect(r.prompts[0]?.content).toBe(buildHandoffPrompt("prompt from file", CALLER));
  });

  test("the first message names the session it came from", () => {
    expect(buildHandoffPrompt("  Continue.\n", CALLER)).toBe(
      'Continue.\n\n(Handed off from session old-1 ("M6: ENT-753").)',
    );
    expect(buildHandoffPrompt("Continue.", { ...CALLER, title: null })).toBe(
      "Continue.\n\n(Handed off from session old-1.)",
    );
  });

  test("refuses a second handoff from the same session", async () => {
    const r = recordingDeps({ ...CALLER, metadata: { handedOffTo: "earlier-1" } });
    await expect(
      handOffSession({ sessionId: "old-1", title: "t", prompt: "p" }, r.deps),
    ).rejects.toThrow("already handed off to earlier-1");
    expect(r.calls).toEqual([]);
  });

  test("refuses an unknown caller", async () => {
    const r = recordingDeps(null);
    await expect(
      handOffSession({ sessionId: "nope", title: "t", prompt: "p" }, r.deps),
    ).rejects.toThrow("Unknown session: nope");
  });

  test("a failed prompt leaves the caller open and moves no client", async () => {
    const r = recordingDeps();
    r.failNextPrompt();
    await expect(
      handOffSession({ sessionId: "old-1", title: "t", prompt: "p" }, r.deps),
    ).rejects.toThrow("agent-host down");
    expect(r.handedOff).toEqual([]);
    expect(r.announced).toEqual([]);
  });

  test("worktree: bootstraps one off the caller's repo and starts the session in it", async () => {
    const r = recordingDeps();
    r.deps.getProfile = () => "auto";
    const result = await handOffSession(
      {
        sessionId: "old-1",
        title: "R2 phase 2",
        promptFile: "tmp/r2/HANDOFF.md",
        worktree: "r2-phase2",
        worktreeBase: "origin/main",
      },
      r.deps,
    );
    expect(r.worktrees).toEqual([
      { branch: "r2-phase2", base: "origin/main", folder: "/repo", profile: "auto" },
    ]);
    // The prompt file is still read from the caller's folder (the worktree
    // links tmp/ back to it anyway).
    expect(r.files).toEqual(["/repo/tmp/r2/HANDOFF.md"]);
    expect(r.drafts[0]?.cwd).toBe("/repo.worktrees/r2-phase2");
    expect(r.prompts[0]?.cwd).toBe("/repo.worktrees/r2-phase2");
    expect(result.cwd).toBe("/repo.worktrees/r2-phase2");
    expect(r.calls).toEqual(["worktree", "create", "title", "prompt", "mark", "announce"]);
  });

  test("worktree: refuses targetCwd alongside it, and an empty prompt makes no worktree", async () => {
    const r = recordingDeps();
    await expect(
      handOffSession(
        { sessionId: "old-1", title: "t", prompt: "p", worktree: "b", targetCwd: "/other" },
        r.deps,
      ),
    ).rejects.toThrow("not both");
    r.deps.readFile = () => "";
    await expect(
      handOffSession({ sessionId: "old-1", title: "t", promptFile: "x.md", worktree: "b" }, r.deps),
    ).rejects.toThrow("Handoff prompt is empty");
    expect(r.calls).toEqual([]);
  });

  test("refuses an empty prompt file", async () => {
    const r = recordingDeps();
    r.deps.readFile = () => "  \n";
    await expect(
      handOffSession({ sessionId: "old-1", title: "t", promptFile: "/empty.md" }, r.deps),
    ).rejects.toThrow("Handoff prompt is empty");
    expect(r.calls).toEqual([]);
  });
});

describe("handoffSchema", () => {
  test("takes exactly one of prompt and promptFile", () => {
    const base = { sessionId: "s", title: "t" };
    expect(handoffSchema.safeParse({ ...base, prompt: "p" }).success).toBe(true);
    expect(handoffSchema.safeParse({ ...base, promptFile: "f.md" }).success).toBe(true);
    expect(handoffSchema.safeParse(base).success).toBe(false);
    expect(handoffSchema.safeParse({ ...base, prompt: "p", promptFile: "f.md" }).success).toBe(
      false,
    );
  });

  test("worktree excludes targetCwd, and worktreeBase needs worktree", () => {
    const base = { sessionId: "s", title: "t", prompt: "p" };
    expect(handoffSchema.safeParse({ ...base, worktree: "feat/x" }).success).toBe(true);
    expect(handoffSchema.safeParse({ ...base, worktree: "x", targetCwd: "/a" }).success).toBe(
      false,
    );
    expect(handoffSchema.safeParse({ ...base, worktreeBase: "origin/main" }).success).toBe(false);
  });

  test("trims the title and rejects a blank one", () => {
    expect(handoffSchema.parse({ sessionId: "s", title: "  M7  ", prompt: "p" }).title).toBe("M7");
    expect(handoffSchema.safeParse({ sessionId: "s", title: "   ", prompt: "p" }).success).toBe(
      false,
    );
  });
});
