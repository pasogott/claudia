/**
 * `session.handoff`: a session passes its work to a fresh one in one call.
 *
 * Long work outgrows one context window. Instead of compacting, the agent
 * writes a handoff prompt and calls this: the new session is created with the
 * caller's settings, named, and already working on that prompt by the time
 * anyone looks. The two are linked both ways (`previous_session_id` on the new
 * row, `handedOffTo` in the old row's metadata), the old one is resolved but
 * left readable, and every client showing the old session follows to the new
 * one.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DraftSessionParams } from "./session-create";

/** Stream event type, emitted as `session.<callerId>.handoff`. */
export const HANDOFF_EVENT_TYPE = "handoff";

/** Payload of `session.<callerId>.handoff`. */
export interface HandoffEventPayload {
  /** The session that handed off (the one the event is scoped to). */
  sessionId: string;
  /** The session that took over. */
  targetSessionId: string;
  workspaceId: string;
  cwd: string;
  title: string;
}

export interface HandoffParams {
  sessionId: string;
  title: string;
  prompt?: string;
  promptFile?: string;
  targetCwd?: string;
  model?: string;
  profile?: string;
}

/** The slice of a stored session the handoff reads. */
export interface HandoffCaller {
  id: string;
  workspaceId: string;
  agent: string;
  model: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
}

export interface HandoffDeps {
  getSession: (sessionId: string) => HandoffCaller | null;
  getWorkspaceCwd: (workspaceId: string) => string | null;
  getProfile: (sessionId: string) => string | null;
  readFile: (path: string) => string;
  createDraft: (params: DraftSessionParams) => {
    sessionId: string;
    workspaceId: string;
    agent: string;
    model: string;
  };
  setTitle: (sessionId: string, title: string) => void;
  sendPrompt: (params: {
    sessionId: string;
    content: string;
    cwd: string;
    model: string;
    agent: string;
  }) => Promise<unknown>;
  /** Record `handedOffTo` on the caller and resolve it. */
  markHandedOff: (sessionId: string, targetSessionId: string) => void;
  announce: (payload: HandoffEventPayload) => void;
}

export interface HandoffResult {
  sessionId: string;
  previousSessionId: string;
  workspaceId: string;
  cwd: string;
  title: string;
  agent: string;
  model: string;
  profile: string;
  status: "running";
}

const EFFORTS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function bootstrapSettings(metadata: Record<string, unknown> | null): {
  thinking?: boolean;
  effort?: Effort;
  systemPrompt?: string;
} {
  const effort = metadata?.bootstrapEffort;
  const thinking = metadata?.bootstrapThinking;
  const systemPrompt = metadata?.bootstrapSystemPrompt;
  return {
    effort: EFFORTS.includes(effort as Effort) ? (effort as Effort) : undefined,
    thinking: typeof thinking === "boolean" ? thinking : undefined,
    systemPrompt: typeof systemPrompt === "string" && systemPrompt ? systemPrompt : undefined,
  };
}

/**
 * The new session's first message: the caller's prompt, plus one line naming
 * where it came from, so the new session can read the old transcript
 * (`anima session get_history`) when the prompt leaves something out.
 */
export function buildHandoffPrompt(prompt: string, caller: HandoffCaller): string {
  const from = caller.title ? `session ${caller.id} ("${caller.title}")` : `session ${caller.id}`;
  return `${prompt.trim()}\n\n(Handed off from ${from}.)`;
}

export async function handOffSession(
  params: HandoffParams,
  deps: HandoffDeps,
): Promise<HandoffResult> {
  const caller = deps.getSession(params.sessionId);
  if (!caller) throw new Error(`Unknown session: ${params.sessionId}`);

  // A session hands off once. Its work now lives in the session it handed
  // to, and a second handoff from it would fork that work (or, from a turn
  // stuck in a loop, start a chain of sessions nobody asked for).
  const previousTarget = caller.metadata?.handedOffTo;
  if (typeof previousTarget === "string" && previousTarget) {
    throw new Error(
      `Session ${caller.id} already handed off to ${previousTarget}; a session hands off only once`,
    );
  }

  const callerCwd = deps.getWorkspaceCwd(caller.workspaceId);
  const cwd = params.targetCwd ? expandHome(params.targetCwd) : callerCwd;
  if (!cwd) throw new Error(`No workspace folder for session ${caller.id}; pass targetCwd`);

  // A relative prompt file is where the caller wrote it: in its own folder.
  const rawPrompt =
    params.prompt ?? deps.readFile(resolve(callerCwd ?? cwd, expandHome(params.promptFile ?? "")));
  if (!rawPrompt.trim()) throw new Error("Handoff prompt is empty");

  const title = params.title.trim();
  const profile = params.profile ?? deps.getProfile(caller.id) ?? "yolo";

  const draft = deps.createDraft({
    cwd,
    agent: caller.agent,
    model: params.model ?? caller.model,
    ...bootstrapSettings(caller.metadata),
    profile,
    previousSessionId: caller.id,
  });
  // Named before the prompt goes out, so the nav never shows the
  // first-prompt fallback for it.
  deps.setTitle(draft.sessionId, title);

  await deps.sendPrompt({
    sessionId: draft.sessionId,
    content: buildHandoffPrompt(rawPrompt, caller),
    cwd,
    model: draft.model,
    agent: draft.agent,
  });

  // Only once the new session is actually working: a failed prompt leaves the
  // caller open, so it can try again.
  deps.markHandedOff(caller.id, draft.sessionId);
  deps.announce({
    sessionId: caller.id,
    targetSessionId: draft.sessionId,
    workspaceId: draft.workspaceId,
    cwd,
    title,
  });

  return {
    sessionId: draft.sessionId,
    previousSessionId: caller.id,
    workspaceId: draft.workspaceId,
    cwd,
    title,
    agent: draft.agent,
    model: draft.model,
    profile,
    status: "running",
  };
}
