import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findGitLayout, worktreesConventionRoot } from "./git-layout";
import {
  addWorkspaceFolder,
  closeDb,
  createWorkspace,
  getOrCreateWorkspace,
  getWorkspaceByCwd,
  listWorkspaceFolders,
  resolveWorkspaceForCwd,
} from "./workspace";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** A main repo at `<root>/proj` with a `.git` dir, like a clone. */
function makeRepo(root: string, name = "proj"): string {
  const repo = join(root, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

/** A linked worktree's `.git` file, as `git worktree add` writes it. */
function makeWorktree(repo: string, path: string): string {
  mkdirSync(path, { recursive: true });
  const name = path.split("/").pop();
  writeFileSync(join(path, ".git"), `gitdir: ${repo}/.git/worktrees/${name}\n`);
  return path;
}

describe("git layout", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "anima-git-layout-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds the top folder of a repo from a subfolder", () => {
    const repo = makeRepo(root);
    mkdirSync(join(repo, "packages", "foo"), { recursive: true });
    expect(findGitLayout(join(repo, "packages", "foo"))).toEqual({
      toplevel: repo,
      mainRepo: null,
    });
  });

  it("recognizes a real git worktree and its main repo", () => {
    const repo = join(root, "real");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const worktree = join(root, "real.worktrees", "feat");
    git(repo, "worktree", "add", "-q", "-b", "feat", worktree);
    mkdirSync(join(worktree, "src"));

    expect(findGitLayout(join(worktree, "src"))).toEqual({ toplevel: worktree, mainRepo: repo });
  });

  it("does not mistake a submodule for a worktree", () => {
    const repo = makeRepo(root);
    const sub = join(repo, "vendor", "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), `gitdir: ../../.git/modules/lib\n`);
    expect(findGitLayout(sub)).toEqual({ toplevel: sub, mainRepo: null });
  });

  it("reads the <repo>.worktrees naming without touching the disk", () => {
    expect(worktreesConventionRoot("/p/swarm.worktrees/kiliman/fix")).toBe("/p/swarm");
    expect(worktreesConventionRoot("/p/swarm.worktrees")).toBe("/p/swarm");
    expect(worktreesConventionRoot("/p/swarm/src")).toBeNull();
  });
});

describe("workspace folders", () => {
  let dataDir: string;
  let root: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.ANIMA_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "anima-ws-folders-db-"));
    process.env.ANIMA_DATA_DIR = dataDir;
    closeDb();
    root = realpathSync(mkdtempSync(join(tmpdir(), "anima-ws-folders-")));
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("files a worktree under its repo's workspace and remembers it as a folder", () => {
    const repo = makeRepo(root);
    const ws = createWorkspace({ name: "proj", cwd: repo });
    const worktree = makeWorktree(repo, join(root, "proj.worktrees", "r2-phase2"));

    const result = getOrCreateWorkspace(join(worktree));
    expect(result).toMatchObject({ created: false, workspace: { id: ws.id } });
    expect(listWorkspaceFolders(ws.id).map((f) => [f.path, f.kind])).toEqual([
      [repo, "root"],
      [worktree, "worktree"],
    ]);
    expect(resolveWorkspaceForCwd(worktree)?.match).toBe("folder");
  });

  it("finds a worktree kept anywhere, through its .git file", () => {
    const repo = makeRepo(root);
    const ws = createWorkspace({ name: "proj", cwd: repo });
    const worktree = makeWorktree(repo, join(root, "elsewhere", "hotfix"));
    expect(resolveWorkspaceForCwd(join(worktree))).toMatchObject({
      match: "worktree",
      workspace: { id: ws.id },
    });
  });

  it("files a subfolder of a member repo under it without adding the subfolder", () => {
    const repo = makeRepo(root);
    const ws = createWorkspace({ name: "proj", cwd: repo });
    const sub = join(repo, "packages", "foo");
    mkdirSync(sub, { recursive: true });

    expect(resolveWorkspaceForCwd(sub)).toMatchObject({
      match: "subfolder",
      workspace: { id: ws.id },
    });
    expect(listWorkspaceFolders(ws.id)).toHaveLength(1);
  });

  it("never folds a project into a workspace at a parent folder that isn't its repo", () => {
    const home = join(root, "home");
    mkdirSync(home);
    createWorkspace({ name: "home", cwd: home });
    const repo = makeRepo(home, "project");
    const plain = join(home, "notes");
    mkdirSync(plain);

    expect(resolveWorkspaceForCwd(repo)).toBeNull();
    expect(resolveWorkspaceForCwd(plain)).toBeNull();
  });

  it("files a removed worktree by its <repo>.worktrees path", () => {
    const repo = makeRepo(root);
    const ws = createWorkspace({ name: "proj", cwd: repo });
    const gone = join(root, "proj.worktrees", "landed");
    expect(resolveWorkspaceForCwd(gone)).toMatchObject({
      match: "worktree",
      workspace: { id: ws.id },
    });
  });

  it("starts a worktree's first session in a workspace for its main repo", () => {
    const repo = makeRepo(root, "fresh");
    const worktree = makeWorktree(repo, join(root, "fresh.worktrees", "feat"));

    const result = getOrCreateWorkspace(worktree);
    expect(result.created).toBe(true);
    expect(result.workspace).toMatchObject({ name: "fresh", cwd: repo });
    expect(getWorkspaceByCwd(worktree)?.id).toBe(result.workspace.id);
  });

  it("refuses to move a folder that belongs to another workspace", () => {
    const a = createWorkspace({ name: "a", cwd: makeRepo(root, "a") });
    const b = createWorkspace({ name: "b", cwd: makeRepo(root, "b") });
    const shared = join(root, "shared");
    addWorkspaceFolder(a.id, shared, "added");
    expect(addWorkspaceFolder(a.id, shared, "added").workspaceId).toBe(a.id);
    expect(() => addWorkspaceFolder(b.id, shared, "added")).toThrow("already belongs");
  });
});
