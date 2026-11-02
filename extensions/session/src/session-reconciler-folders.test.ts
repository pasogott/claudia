/**
 * The reconciler sweeps every folder of a workspace (#107): the root, live
 * worktrees under `<root>.worktrees/`, and the folders its sessions run in.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import os from "node:os";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "@anima/shared";
import { listConventionWorktrees } from "./git-layout";
import { foldersToSweep, reconcileWorkspace } from "./session-reconciler";
import { closeSessionDb, getStoredSession, upsertSession } from "./session-store";
import { closeDb, getWorkspaceFolder, type Workspace } from "./workspace-db";
import { createWorkspace } from "./workspace";
import { initRuntime, resetRuntime, type SessionRuntime } from "./runtime";

const DAY = 24 * 3_600_000;

describe("reconciling a workspace's folders", () => {
  let home: string;
  let originalHome: string | undefined;
  let homedirSpy: ReturnType<typeof spyOn>;
  let archived: string[];
  let root: string;
  let worktree: string;
  let workspace: Workspace;
  // Tests share one database for the whole run, so every id is unique.
  const id = (name: string) => `${name}-${crypto.randomUUID()}`;

  /** A transcript in `cwd`'s Claude Code project directory. */
  function transcript(cwd: string, sessionId: string): void {
    const dir = claudeProjectDir(cwd);
    mkdirSync(dir, { recursive: true });
    const line = { type: "user", cwd, message: { role: "user", content: `hello ${sessionId}` } };
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(line)}\n`);
  }

  /** A chat row last active long enough ago to be pruned if its transcript is gone. */
  function storedSession(sessionId: string, cwd: string): void {
    upsertSession({
      id: sessionId,
      workspaceId: workspace.id,
      providerSessionId: sessionId,
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      cwd,
      lastActivity: new Date(Date.now() - DAY).toISOString(),
    });
  }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(os.tmpdir(), "anima-reconcile-folders-")));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home);

    archived = [];
    initRuntime({
      sessionConfig: { model: "claude-opus-5" },
      config: {},
      registry: { archiveSession: (sessionId: string) => archived.push(sessionId) },
    } as unknown as SessionRuntime);

    root = join(home, `proj-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, ".git"), { recursive: true });
    worktree = join(`${root}.worktrees`, "feature");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${root}/.git/worktrees/feature\n`);

    workspace = createWorkspace({ name: "proj", cwd: root });
  });

  afterEach(() => {
    resetRuntime();
    closeSessionDb();
    closeDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("adopts a live worktree and files its transcripts under the workspace", () => {
    const inRoot = id("root");
    const inWorktree = id("wt");
    transcript(root, inRoot);
    transcript(worktree, inWorktree);

    reconcileWorkspace(workspace);

    expect(getWorkspaceFolder(worktree)).toMatchObject({
      workspaceId: workspace.id,
      kind: "worktree",
    });
    expect(getStoredSession(inRoot)).toMatchObject({ workspaceId: workspace.id, cwd: root });
    expect(getStoredSession(inWorktree)).toMatchObject({
      workspaceId: workspace.id,
      cwd: worktree,
    });
  });

  it("prunes each folder only against its own sessions", () => {
    const worktreeSession = id("wt-alive");
    const gone = id("root-gone");
    transcript(root, id("root-alive"));
    transcript(worktree, worktreeSession);
    storedSession(worktreeSession, worktree);
    storedSession(gone, root);

    reconcileWorkspace(workspace);

    // The worktree session isn't in the root's transcript directory, and
    // must not be archived for it.
    expect(archived).toEqual([gone]);
  });

  it("keeps a session whose transcript sits under another of the workspace's folders", () => {
    const misfiled = id("misfiled");
    transcript(root, id("root-alive"));
    transcript(worktree, misfiled);
    storedSession(misfiled, root);

    reconcileWorkspace(workspace);

    expect(archived).toEqual([]);
    // The recorded folder stands.
    expect(getStoredSession(misfiled)?.cwd).toBe(root);
  });

  it("sweeps the folders sessions run in, but not another workspace's folders", () => {
    const sub = join(root, "packages", "foo");
    const elsewhere = join(home, `other-${crypto.randomUUID().slice(0, 8)}`);
    createWorkspace({ name: "other", cwd: elsewhere });

    expect(foldersToSweep(workspace, [{ cwd: sub }, { cwd: elsewhere }, {}])).toEqual([root, sub]);
  });

  it("adopts only real worktrees Claude Code has run in", () => {
    const grouped = join(`${root}.worktrees`, "kiliman", "fix-thing");
    mkdirSync(grouped, { recursive: true });
    writeFileSync(join(grouped, ".git"), `gitdir: ${root}/.git/worktrees/fix-thing\n`);
    const unused = join(`${root}.worktrees`, "never-opened");
    mkdirSync(unused);
    writeFileSync(join(unused, ".git"), `gitdir: ${root}/.git/worktrees/never-opened\n`);
    const clone = join(`${root}.worktrees`, "stray-clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    for (const folder of [grouped, unused, clone, worktree]) mkdirSync(folder, { recursive: true });
    transcript(grouped, id("grouped"));
    transcript(clone, id("clone"));

    expect(listConventionWorktrees(root).sort()).toEqual([worktree, grouped, unused].sort());

    reconcileWorkspace(workspace);

    // A grouping folder's worktree joins; a worktree with no transcripts has
    // nothing to file; a clone isn't a worktree of this repo.
    expect(getWorkspaceFolder(grouped)?.workspaceId).toBe(workspace.id);
    expect(getWorkspaceFolder(join(`${root}.worktrees`, "kiliman"))).toBeNull();
    expect(getWorkspaceFolder(unused)).toBeNull();
    expect(getWorkspaceFolder(clone)).toBeNull();
  });
});
