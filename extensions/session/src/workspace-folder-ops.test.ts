/**
 * Hand-run folder operations on a workspace (#107): add, remove, set root,
 * move, and merging another workspace in.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import os from "node:os";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "@anima/shared";
import { resolveProjectDir } from "./claude-projects";
import { closeSessionDb, getStoredSession, upsertSession } from "./session-store";
import { createWorkspace, updateWorkspaceProject } from "./workspace";
import { closeDb, getWorkspace, getWorkspaceFolder, type Workspace } from "./workspace-db";
import { addFolder, moveFolder, removeFolder, setRoot } from "./workspace-folders";

describe("workspace folder operations", () => {
  let home: string;
  let originalHome: string | undefined;
  let homedirSpy: ReturnType<typeof spyOn>;
  let root: string;
  let workspace: Workspace;
  // Tests share one database for the whole run, so every id is unique.
  const id = (name: string) => `${name}-${crypto.randomUUID()}`;

  /** A git repo (a `.git` folder is all the layout check reads). */
  function repo(name: string): string {
    const path = join(home, name);
    mkdirSync(join(path, ".git"), { recursive: true });
    return path;
  }

  function folder(name: string): string {
    const path = join(home, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  function transcript(cwd: string, sessionId: string): void {
    const dir = claudeProjectDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", cwd })}\n`);
  }

  function session(sessionId: string, workspaceId: string, cwd?: string): void {
    upsertSession({
      id: sessionId,
      workspaceId,
      providerSessionId: sessionId,
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      cwd,
    });
  }

  const memoryOf = (path: string) => join(claudeProjectDir(path), "memory");

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(os.tmpdir(), "anima-folder-ops-")));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
    root = repo("proj");
    workspace = createWorkspace({ name: "proj", cwd: root });
  });

  afterEach(() => {
    closeSessionDb();
    closeDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe("addFolder", () => {
    it("adds a non-repo folder and links the root's auto memory into it", () => {
      const notes = folder("notes");
      const result = addFolder(workspace.id, notes);

      expect(getWorkspaceFolder(notes)).toMatchObject({
        workspaceId: workspace.id,
        kind: "added",
      });
      expect(lstatSync(memoryOf(notes)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(memoryOf(notes))).toBe(memoryOf(root));
      expect(existsSync(memoryOf(root))).toBe(true);
      expect(result.folders.map((f) => f.path)).toEqual([root, notes]);
    });

    it("adds a worktree of the root repo as a worktree, with no memory link", () => {
      const worktree = folder("proj.worktrees/feature");
      writeFileSync(join(worktree, ".git"), `gitdir: ${root}/.git/worktrees/feature\n`);

      const result = addFolder(workspace.id, worktree);

      expect(getWorkspaceFolder(worktree)?.kind).toBe("worktree");
      expect(existsSync(memoryOf(worktree))).toBe(false);
      expect(result.notes.join("\n")).not.toContain("auto memory");
    });

    it("leaves a folder's own auto memory alone", () => {
      const notes = folder("notes");
      mkdirSync(memoryOf(notes), { recursive: true });
      writeFileSync(join(memoryOf(notes), "MEMORY.md"), "mine");

      const result = addFolder(workspace.id, notes);

      expect(lstatSync(memoryOf(notes)).isSymbolicLink()).toBe(false);
      expect(result.notes.join("\n")).toContain("already has its own files");
    });

    it("refuses another workspace's root unless merging", () => {
      const other = createWorkspace({ name: "other", cwd: folder("other") });
      expect(() => addFolder(workspace.id, other.cwd)).toThrow(/merge: true/);
    });

    it("merges another workspace in: sessions, folders, and a soft delete", () => {
      const otherRoot = folder("proj-old-worktree");
      const other = createWorkspace({ name: "old", cwd: otherRoot });
      updateWorkspaceProject(other.id, { aliases: ["r2queue"] });
      const pinned = id("ses-pinned");
      const rootless = id("ses-rootless");
      session(pinned, other.id, otherRoot);
      session(rootless, other.id);

      const result = addFolder(workspace.id, otherRoot, { merge: true });

      expect(getWorkspace(other.id)).toBeNull();
      expect(getWorkspace(workspace.id)?.aliases).toEqual(["r2queue"]);
      expect(getWorkspaceFolder(otherRoot)).toMatchObject({
        workspaceId: workspace.id,
        kind: "added",
      });
      expect(getStoredSession(pinned)).toMatchObject({
        workspaceId: workspace.id,
        cwd: otherRoot,
      });
      // A session with no folder of its own ran in the merged workspace's
      // root, not in this one's.
      expect(getStoredSession(rootless)).toMatchObject({
        workspaceId: workspace.id,
        cwd: otherRoot,
      });
      expect(result.notes[0]).toContain("2 sessions, 1 folders");
    });
  });

  describe("removeFolder", () => {
    it("refuses the root", () => {
      expect(() => removeFolder(workspace.id, root)).toThrow(/set another root first/);
    });

    it("removes an added folder and its memory link", () => {
      const notes = folder("notes");
      addFolder(workspace.id, notes);

      removeFolder(workspace.id, notes);

      expect(getWorkspaceFolder(notes)).toBeNull();
      expect(existsSync(memoryOf(notes))).toBe(false);
      expect(existsSync(memoryOf(root))).toBe(true);
    });
  });

  describe("setRoot", () => {
    it("makes a member the root and pins rootless sessions to the old one", () => {
      const other = repo("proj-api");
      addFolder(workspace.id, other);
      const rootless = id("ses-rootless");
      session(rootless, workspace.id);

      setRoot(workspace.id, other);

      expect(getWorkspace(workspace.id)?.cwd).toBe(other);
      expect(getWorkspaceFolder(other)?.kind).toBe("root");
      expect(getWorkspaceFolder(root)?.kind).toBe("added");
      expect(getStoredSession(rootless)?.cwd).toBe(root);
    });
  });

  describe("moveFolder", () => {
    it("moves the root: sessions follow, transcripts link, the old path goes inactive", () => {
      const inRoot = id("ses-root");
      const inSub = id("ses-sub");
      const rootless = id("ses-rootless");
      const sub = join(root, "packages", "foo");
      transcript(root, inRoot);
      transcript(sub, inSub);
      session(inRoot, workspace.id, root);
      session(inSub, workspace.id, sub);
      session(rootless, workspace.id);
      const moved = repo("projects/proj");

      const result = moveFolder(workspace.id, root, moved);

      expect(getWorkspace(workspace.id)?.cwd).toBe(moved);
      expect(getWorkspaceFolder(moved)?.kind).toBe("root");
      expect(getWorkspaceFolder(root)).toMatchObject({ kind: "added" });
      expect(getWorkspaceFolder(root)?.inactiveAt).not.toBeNull();
      expect(getStoredSession(inRoot)?.cwd).toBe(moved);
      expect(getStoredSession(rootless)?.cwd).toBe(moved);
      expect(getStoredSession(inSub)?.cwd).toBe(join(moved, "packages", "foo"));

      // Each folder's transcripts are found from the new path, through a link
      // to the old folder (never a rename, which Libby would re-ingest).
      const newDir = claudeProjectDir(moved);
      expect(lstatSync(newDir).isSymbolicLink()).toBe(true);
      expect(resolveProjectDir(moved)).toBe(newDir);
      expect(existsSync(join(newDir, `${inRoot}.jsonl`))).toBe(true);
      expect(
        existsSync(join(claudeProjectDir(join(moved, "packages", "foo")), `${inSub}.jsonl`)),
      ).toBe(true);
      expect(lstatSync(claudeProjectDir(root)).isDirectory()).toBe(true);
      expect(result.notes.filter((n) => n.startsWith("transcripts: linked"))).toHaveLength(2);
    });

    it("leaves a new path that already has its own transcripts alone", () => {
      const inRoot = id("ses-root");
      transcript(root, inRoot);
      session(inRoot, workspace.id, root);
      const moved = folder("elsewhere");
      transcript(moved, id("ses-new"));

      const result = moveFolder(workspace.id, root, moved);

      expect(lstatSync(claudeProjectDir(moved)).isSymbolicLink()).toBe(false);
      expect(result.notes.join("\n")).toContain("already has its own files");
      expect(getStoredSession(inRoot)?.cwd).toBe(moved);
    });

    it("merges a workspace started at the new path before the move was recorded", () => {
      const moved = folder("moved");
      const early = createWorkspace({ name: "moved", cwd: moved });
      const earlySession = id("ses-early");
      session(earlySession, early.id, moved);

      expect(() => moveFolder(workspace.id, root, moved)).toThrow(/merge: true/);
      moveFolder(workspace.id, root, moved, { merge: true });

      expect(getWorkspace(workspace.id)?.cwd).toBe(moved);
      expect(getWorkspaceFolder(moved)).toMatchObject({
        workspaceId: workspace.id,
        kind: "root",
        inactiveAt: null,
      });
      expect(getStoredSession(earlySession)?.workspaceId).toBe(workspace.id);
      expect(getWorkspace(early.id)).toBeNull();
    });

    it("moves an added folder and re-links the root's memory at the new path", () => {
      const notes = folder("notes");
      addFolder(workspace.id, notes);
      const moved = folder("notes-moved");

      moveFolder(workspace.id, notes, moved);

      expect(getWorkspaceFolder(moved)?.kind).toBe("added");
      expect(getWorkspaceFolder(notes)?.inactiveAt).not.toBeNull();
      expect(readlinkSync(memoryOf(moved))).toBe(memoryOf(root));
    });
  });
});
