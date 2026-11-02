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
  };
  return {
    deps,
    calls,
    drafts,
    prompts,
    files,
    handedOff,
    announced,
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

  test("trims the title and rejects a blank one", () => {
    expect(handoffSchema.parse({ sessionId: "s", title: "  M7  ", prompt: "p" }).title).toBe("M7");
    expect(handoffSchema.safeParse({ sessionId: "s", title: "   ", prompt: "p" }).success).toBe(
      false,
    );
  });
});
