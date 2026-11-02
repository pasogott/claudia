import { describe, expect, test } from "bun:test";
import { capturedBranch, describeSessionFolder } from "./session-folder";
import type { WorkspaceFolder } from "./workspace-db";

const ROOT = "/repo/app";

function folder(
  path: string,
  kind: WorkspaceFolder["kind"],
  inactiveAt: string | null = null,
): WorkspaceFolder {
  return { path, workspaceId: "ws_folder_label", kind, inactiveAt, createdAt: "2026-11-02" };
}

const FOLDERS = [
  folder(ROOT, "root"),
  folder("/repo/app.worktrees/feat/login", "worktree"),
  folder("/elsewhere/app-hotfix", "worktree"),
  folder("/repo/app.worktrees/old-branch", "worktree", "2026-11-01 10:00:00"),
  folder("/repo/api", "added"),
];

describe("describeSessionFolder", () => {
  test("a session in the root (or with no cwd) gets no chip", () => {
    expect(describeSessionFolder({ cwd: ROOT, root: ROOT, folders: FOLDERS })).toBeNull();
    expect(describeSessionFolder({ cwd: null, root: ROOT, folders: FOLDERS })).toBeNull();
  });

  test("a worktree under <repo>.worktrees/ is named by its branch path", () => {
    expect(
      describeSessionFolder({
        cwd: "/repo/app.worktrees/feat/login",
        root: ROOT,
        folders: FOLDERS,
      }),
    ).toEqual({
      kind: "worktree",
      label: "feat/login",
      path: "/repo/app.worktrees/feat/login",
      inactive: false,
    });
  });

  test("a captured branch outranks the folder name", () => {
    const described = describeSessionFolder({
      cwd: "/elsewhere/app-hotfix",
      root: ROOT,
      folders: FOLDERS,
      branch: "hotfix/crash",
    });
    expect(described?.label).toBe("hotfix/crash");
  });

  test("a worktree elsewhere falls back to its folder name", () => {
    expect(
      describeSessionFolder({ cwd: "/elsewhere/app-hotfix", root: ROOT, folders: FOLDERS })?.label,
    ).toBe("app-hotfix");
  });

  test("an inactive folder is flagged", () => {
    const described = describeSessionFolder({
      cwd: "/repo/app.worktrees/old-branch",
      root: ROOT,
      folders: FOLDERS,
    });
    expect(described).toMatchObject({ kind: "worktree", label: "old-branch", inactive: true });
  });

  test("an added folder is named by its basename", () => {
    expect(
      describeSessionFolder({ cwd: "/repo/api", root: ROOT, folders: FOLDERS, branch: "main" }),
    ).toMatchObject({ kind: "added", label: "api" });
  });

  test("a subfolder of the root is named by its path from the root", () => {
    expect(
      describeSessionFolder({ cwd: "/repo/app/packages/ui", root: ROOT, folders: FOLDERS }),
    ).toMatchObject({ kind: "subfolder", label: "packages/ui", inactive: false });
  });

  test("a subfolder of a worktree carries the worktree's name", () => {
    expect(
      describeSessionFolder({
        cwd: "/repo/app.worktrees/feat/login/packages/ui",
        root: ROOT,
        folders: FOLDERS,
      }),
    ).toMatchObject({ kind: "subfolder", label: "feat/login/packages/ui" });
  });

  test("a sibling with a shared prefix is not a subfolder", () => {
    // /repo/app-other starts with "/repo/app" but is not inside it.
    expect(
      describeSessionFolder({ cwd: "/repo/app-other", root: ROOT, folders: FOLDERS }),
    ).toMatchObject({ kind: "subfolder", label: "app-other" });
  });
});

describe("capturedBranch", () => {
  test("only trusts a capture taken in the session's own folder", () => {
    const metadata = { gitStatus: { cwd: ROOT, branch: "main" } };
    expect(capturedBranch(metadata, ROOT)).toBe("main");
    expect(capturedBranch(metadata, "/repo/app.worktrees/feat/login")).toBeNull();
    expect(capturedBranch(null, ROOT)).toBeNull();
    expect(capturedBranch({ gitStatus: { cwd: ROOT, branch: null } }, ROOT)).toBeNull();
  });
});
