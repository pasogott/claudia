import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  DEFAULT_WORKTREE_SCRIPT,
  parseWorktreeOutput,
  runWorktreeScript,
  sessionFolder,
  trustFolder,
  validateWorktreeBranch,
  worktreeRepoFor,
  worktreeScriptFor,
  type WorktreeDeps,
} from "./worktree";

// Outside any git repo, or a test folder would resolve into anima's.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "anima-worktree-test-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** A fresh repo with one commit on `main` and a gitignored tmp/ holding a note. */
function makeRepo(name = `repo${++counter}`): string {
  const repo = join(ROOT, name);
  mkdirSync(join(repo, "tmp"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "tmp/\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, "tmp", "NOTES.md"), "the notes\n");
  return repo;
}

/** Real git, recorded trust (never the real ~/.claude.json). */
function realDeps(): WorktreeDeps & { trusted: string[] } {
  const trusted: string[] = [];
  return {
    trusted,
    run: runWorktreeScript,
    trust: (folder) => {
      trusted.push(folder);
      return true;
    },
  };
}

describe("validateWorktreeBranch", () => {
  test("takes plain and grouped branch names", () => {
    expect(validateWorktreeBranch("r2-phase2")).toBe("r2-phase2");
    expect(validateWorktreeBranch(" feat/worktrees ")).toBe("feat/worktrees");
  });

  test("refuses anything that could escape the folder or read as an option", () => {
    for (const bad of ["../x", "a/../b", "-rf", "/abs", "x/", ".hidden", "a/.b", "a b", "x.lock"]) {
      expect(() => validateWorktreeBranch(bad)).toThrow("Not a usable worktree branch name");
    }
  });
});

describe("parseWorktreeOutput", () => {
  test("takes the last non-empty line, so a stray stdout line from a project step is harmless", () => {
    expect(parseWorktreeOutput("installing…\n/a/b.worktrees/x\n\n")).toBe("/a/b.worktrees/x");
    expect(parseWorktreeOutput("  \n")).toBeNull();
  });
});

describe("trustFolder", () => {
  test("marks the folder trusted, keeps everything else, and is idempotent", () => {
    const config = join(ROOT, `claude-${++counter}.json`);
    writeFileSync(
      config,
      JSON.stringify({ numStartups: 3, projects: { "/a": { allowedTools: ["x"] } } }),
    );
    expect(trustFolder("/a", config)).toBe(true);
    expect(trustFolder("/b", config)).toBe(true);
    expect(trustFolder("/a", config)).toBe(false);
    const saved = JSON.parse(readFileSync(config, "utf-8"));
    expect(saved.numStartups).toBe(3);
    expect(saved.projects["/a"]).toEqual({ allowedTools: ["x"], hasTrustDialogAccepted: true });
    expect(saved.projects["/b"]).toEqual({ hasTrustDialogAccepted: true });
  });
});

describe("default bootstrap", () => {
  test("creates the branch from HEAD, links tmp/ (ignored), and is reusable", async () => {
    const repo = makeRepo();
    const deps = realDeps();
    const created = await createWorktree(
      { branch: "feat/thing", folder: repo, profile: "auto" },
      deps,
    );
    const path = `${repo}.worktrees/feat/thing`;
    expect(created).toEqual({
      path,
      branch: "feat/thing",
      repo,
      script: DEFAULT_WORKTREE_SCRIPT,
    });
    expect(git(path, "branch", "--show-current")).toBe("feat/thing");
    expect(lstatSync(join(path, "tmp")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, "tmp"))).toBe(join(repo, "tmp"));
    expect(readFileSync(join(path, "tmp", "NOTES.md"), "utf-8")).toBe("the notes\n");
    // A `tmp/` pattern doesn't match a symlink; the bootstrap ignores it by name.
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // Pre-trusted, since auto can't answer the trust dialog.
    expect(deps.trusted).toEqual([path]);

    // A second call reuses it rather than failing.
    const again = await createWorktree(
      { branch: "feat/thing", folder: repo, profile: "yolo" },
      deps,
    );
    expect(again.path).toBe(path);
    expect(deps.trusted).toEqual([path]); // yolo needs no trust
  });

  test("checks out an existing local branch, and resolves the repo from inside a worktree", async () => {
    const repo = makeRepo();
    git(repo, "branch", "existing");
    const first = await createWorktree(
      { branch: "one", folder: repo, profile: "yolo" },
      realDeps(),
    );
    expect(worktreeRepoFor(join(first.path, "tmp"))).toBe(repo);

    // Asked from inside the first worktree: the new one still sits beside main.
    const second = await createWorktree(
      { branch: "existing", folder: first.path, profile: "yolo" },
      realDeps(),
    );
    expect(second.path).toBe(`${repo}.worktrees/existing`);
    expect(git(second.path, "branch", "--show-current")).toBe("existing");
  });

  test("with an origin: fetches first, branches from origin's default, never tracks it", async () => {
    const upstream = makeRepo();
    const clone = join(ROOT, `clone${++counter}`);
    git(ROOT, "clone", "-q", upstream, clone);
    mkdirSync(join(clone, "tmp"));
    // Moves on upstream after the clone: only a fresh fetch sees these.
    writeFileSync(join(upstream, "later.md"), "later\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "later");
    git(upstream, "branch", "remote-only");

    const fresh = await createWorktree(
      { branch: "fresh", folder: clone, profile: "yolo" },
      realDeps(),
    );
    expect(existsSync(join(fresh.path, "later.md"))).toBe(true);
    // No upstream: a branch started from origin/main must never push to main.
    const upstreamOf = Bun.spawnSync(["git", "config", "--get", "branch.fresh.merge"], {
      cwd: fresh.path,
    });
    expect(upstreamOf.exitCode).toBe(1);

    const tracked = await createWorktree(
      { branch: "remote-only", folder: clone, profile: "yolo" },
      realDeps(),
    );
    expect(git(tracked.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/remote-only",
    );
  });

  test("honours --base", async () => {
    const repo = makeRepo();
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "second.md"), "2\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "second");
    const created = await createWorktree(
      { branch: "from-first", base: first, folder: repo, profile: "yolo" },
      realDeps(),
    );
    expect(git(created.path, "rev-parse", "HEAD")).toBe(first);
  });

  test("a failure surfaces the script's error and makes no session folder", async () => {
    const repo = makeRepo();
    mkdirSync(`${repo}.worktrees/taken`, { recursive: true });
    await expect(
      createWorktree({ branch: "taken", folder: repo, profile: "yolo" }, realDeps()),
    ).rejects.toThrow("is not a worktree of");
  });

  test("refuses a folder outside git", async () => {
    await expect(
      createWorktree({ branch: "x", folder: ROOT, profile: "yolo" }, realDeps()),
    ).rejects.toThrow("not in a git repository");
  });
});

describe("project override", () => {
  test("an executable tmp/scripts/create_worktree runs instead, with the env, and can call the default", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "tmp", "scripts"));
    const script = join(repo, "tmp", "scripts", "create_worktree");
    const envLog = join(repo, "tmp", "env.log");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$ANIMA_MAIN_REPO" "$ANIMA_WORKTREE_PATH" "$ANIMA_SESSION_PROFILE" "$*" > ${envLog}`,
        'path="$("$ANIMA_DEFAULT_WORKTREE_SCRIPT" "$@")"',
        'echo "project step" > "$path/.project-step"',
        'echo "noise from a project step"',
        'echo "$path"',
        "",
      ].join("\n"),
    );
    // Not executable yet: the default runs.
    expect(worktreeScriptFor(repo)).toBe(DEFAULT_WORKTREE_SCRIPT);
    chmodSync(script, 0o755);
    expect(worktreeScriptFor(repo)).toBe(script);

    const created = await createWorktree(
      { branch: "custom", base: "main", folder: repo, profile: "auto" },
      realDeps(),
    );
    expect(created.script).toBe(script);
    expect(created.path).toBe(`${repo}.worktrees/custom`);
    expect(existsSync(join(created.path, ".project-step"))).toBe(true);
    expect(readFileSync(envLog, "utf-8").split("\n")).toEqual([
      repo,
      `${repo}.worktrees/custom`,
      "auto",
      "custom --base main",
      "",
    ]);
  });

  test("a script that prints something other than a folder is an error", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "tmp", "scripts"));
    const script = join(repo, "tmp", "scripts", "create_worktree");
    writeFileSync(script, "#!/usr/bin/env bash\necho /nowhere/at/all\n");
    chmodSync(script, 0o755);
    await expect(
      createWorktree({ branch: "x", folder: repo, profile: "yolo" }, realDeps()),
    ).rejects.toThrow("which is not a folder");
  });
});

describe("sessionFolder", () => {
  const create = async (request: { branch: string; folder: string }) => ({
    path: `${request.folder}.worktrees/${request.branch}`,
  });

  test("passes the folder through without a worktree", async () => {
    expect(await sessionFolder({}, "/repo", "yolo", create)).toBe("/repo");
    expect(await sessionFolder({}, undefined, "yolo", create)).toBeUndefined();
  });

  test("swaps in the worktree, and needs a folder to branch from", async () => {
    expect(await sessionFolder({ worktree: "b" }, "/repo", "auto", create)).toBe(
      "/repo.worktrees/b",
    );
    await expect(sessionFolder({ worktree: "b" }, undefined, "auto", create)).rejects.toThrow(
      "pass cwd",
    );
    await expect(sessionFolder({ worktreeBase: "main" }, "/repo", "auto", create)).rejects.toThrow(
      "worktreeBase needs worktree",
    );
  });
});
