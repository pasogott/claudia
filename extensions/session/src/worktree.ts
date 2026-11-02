/**
 * Start a session in a git worktree (#106).
 *
 * `create_session`, `spawn_agent` and `handoff` take `worktree: "<branch>"`.
 * Anima creates (or reuses) that branch in a worktree at
 * `<repo>.worktrees/<branch>`, bootstraps it, and starts the session there.
 * Workspace resolution (#107) then files the session under the repo's
 * workspace, because a worktree of a member repo is a member itself.
 *
 * The bootstrap is a script: Anima's default (`scripts/create_worktree`), or a
 * project's own executable `<repo>/tmp/scripts/create_worktree`, which can run
 * the default first (`$ANIMA_DEFAULT_WORKTREE_SCRIPT`) and add steps of its own.
 */

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "@anima/shared";
import { findGitLayout } from "./git-layout";

const log = createLogger("SessionExt:Worktree", join(homedir(), ".anima", "logs", "session.log"));

/** The bootstrap that ships with Anima. */
export const DEFAULT_WORKTREE_SCRIPT = resolve(import.meta.dir, "..", "scripts", "create_worktree");

/** Where a project's own bootstrap lives, relative to its main checkout. */
export const PROJECT_WORKTREE_SCRIPT = join("tmp", "scripts", "create_worktree");

/** Longer than a fetch plus a CodeGraph sync; shorter than the gateway's 5 min ceiling. */
const SCRIPT_TIMEOUT_MS = 240_000;

export interface WorktreeOptions {
  /** Branch to check out; also the worktree's folder under `<repo>.worktrees/`. */
  worktree?: string;
  /** Start point for a new branch (default: origin's default branch, freshly fetched). */
  worktreeBase?: string;
}

export interface WorktreeRequest {
  branch: string;
  base?: string;
  /** Any folder in the repo (or in one of its worktrees). */
  folder: string;
  /** The session's permission profile; anything but yolo gets the folder pre-trusted. */
  profile: string;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  repo: string;
  /** The bootstrap that ran. */
  script: string;
}

/**
 * Branch names that are safe as a path under `<repo>.worktrees/`: git's own
 * rules are checked again by the script, this keeps `..` and option-looking
 * names from ever reaching a path or a command line.
 */
export function validateWorktreeBranch(branch: string): string {
  const name = branch.trim();
  const ok =
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
  if (!ok) throw new Error(`Not a usable worktree branch name: "${branch}"`);
  return name;
}

/** Reject option combinations the methods can't honor. */
export function checkWorktreeOptions(options: WorktreeOptions): void {
  if (options.worktreeBase && !options.worktree) {
    throw new Error("worktreeBase needs worktree");
  }
  if (options.worktreeBase?.startsWith("-")) {
    throw new Error(`Not a usable worktreeBase: "${options.worktreeBase}"`);
  }
}

/** The main checkout of the repo `folder` is in. */
export function worktreeRepoFor(folder: string): string {
  const layout = findGitLayout(folder);
  if (!layout) throw new Error(`${folder} is not in a git repository, so it can't have worktrees`);
  return layout.mainRepo ?? layout.toplevel;
}

export function worktreePathFor(repo: string, branch: string): string {
  return `${repo}.worktrees/${branch}`;
}

/** The project's own bootstrap when it has an executable one, else Anima's. */
export function worktreeScriptFor(repo: string): string {
  const project = join(repo, PROJECT_WORKTREE_SCRIPT);
  try {
    if (statSync(project).isFile()) {
      accessSync(project, constants.X_OK);
      return project;
    }
  } catch {
    // Missing or not executable: the default runs.
  }
  return DEFAULT_WORKTREE_SCRIPT;
}

/** The worktree path a bootstrap printed: its last non-empty stdout line. */
export function parseWorktreeOutput(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

/**
 * Mark `folder` as trusted in Claude Code's `~/.claude.json`, so a session
 * that can't answer the workspace-trust dialog (any profile but yolo) doesn't
 * stall on it. Anima does this itself rather than leaving it to the
 * bootstrap, so a project script that replaces the default can't forget it.
 */
export function trustFolder(folder: string, configPath = join(homedir(), ".claude.json")): boolean {
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>)
    : {};
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (projects[folder]?.hasTrustDialogAccepted === true) return false;
  projects[folder] = { ...projects[folder], hasTrustDialogAccepted: true };
  config.projects = projects;
  // Claude Code rewrites this file often: write a sibling and rename over it,
  // so a reader never sees half a file.
  const temp = `${configPath}.anima-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temp, configPath);
  return true;
}

export interface WorktreeDeps {
  run: (
    command: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  trust: (folder: string) => boolean;
}

export async function runWorktreeScript(
  command: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const defaultDeps: WorktreeDeps = {
  run: runWorktreeScript,
  trust: (folder) => trustFolder(folder),
};

/** Create (or reuse) and bootstrap the worktree, and return where it is. */
export async function createWorktree(
  request: WorktreeRequest,
  deps: WorktreeDeps = defaultDeps,
): Promise<CreatedWorktree> {
  const branch = validateWorktreeBranch(request.branch);
  const repo = worktreeRepoFor(request.folder);
  const expected = worktreePathFor(repo, branch);
  const script = worktreeScriptFor(repo);
  const args = [script, branch, ...(request.base ? ["--base", request.base] : [])];

  log.info("Creating worktree", { repo, branch, base: request.base, script });
  const result = await deps.run(args, {
    cwd: repo,
    env: {
      ...(process.env as Record<string, string>),
      ANIMA_MAIN_REPO: repo,
      ANIMA_WORKTREE_PATH: expected,
      ANIMA_SESSION_PROFILE: request.profile,
      ANIMA_DEFAULT_WORKTREE_SCRIPT: DEFAULT_WORKTREE_SCRIPT,
    },
    timeoutMs: SCRIPT_TIMEOUT_MS,
  });
  if (result.stderr.trim()) log.info("Worktree bootstrap output", { stderr: result.stderr.trim() });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-5).join("\n");
    throw new Error(`${script} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }

  const printed = parseWorktreeOutput(result.stdout);
  if (!printed) throw new Error(`${script} printed no worktree path`);
  const path = resolve(repo, printed);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${script} printed "${printed}", which is not a folder`);
  }

  if (request.profile !== "yolo" && deps.trust(path)) {
    log.info("Pre-trusted worktree for Claude Code", { path, profile: request.profile });
  }
  log.info("Worktree ready", { path, branch });
  return { path, branch, repo, script };
}

/**
 * The folder a new session starts in: `folder` itself, or, with `worktree`,
 * the bootstrapped worktree of the repo `folder` is in.
 */
export async function sessionFolder(
  options: WorktreeOptions,
  folder: string | undefined,
  profile: string,
  create: (request: WorktreeRequest) => Promise<{ path: string }> = createWorktree,
): Promise<string | undefined> {
  checkWorktreeOptions(options);
  if (!options.worktree) return folder;
  if (!folder) throw new Error("worktree needs a folder in the repo to branch from (pass cwd)");
  const created = await create({
    branch: options.worktree,
    base: options.worktreeBase,
    folder,
    profile,
  });
  return created.path;
}
