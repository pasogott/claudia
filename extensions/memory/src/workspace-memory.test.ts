/**
 * Memory is per workspace (#107): a session in any of a workspace's folders
 * sees the recent conversations and summaries from all of them.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug } from "@anima/shared";
import { migrate } from "../../../packages/gateway/src/db/migrate";
import {
  closeDb,
  getDb,
  getRecentArchivedSummaries,
  getRecentTranscriptEntries,
  setDbPathForTests,
  transitionActiveConversationsByCwd,
  workspaceFoldersFor,
} from "./db";

const ROOT = "/repo/proj";
const WORKTREE = "/repo/proj.worktrees/feature";
const MOVED = "/old/place/proj";
const SUBFOLDER = "/repo/proj/packages/foo";
const OTHER = "/repo/other";

const sourceFile = (cwd: string, session: string) =>
  `/home/.claude/projects/${claudeProjectSlug(cwd)}/${session}.jsonl`;
const pattern = (cwd: string) => `%${claudeProjectSlug(cwd)}/%`;

function entry(cwd: string, content: string, minute: number): void {
  getDb()
    .query(
      `INSERT INTO memory_transcript_entries (session_id, source_file, role, content, timestamp, cwd)
       VALUES (?, ?, 'user', ?, ?, ?)`,
    )
    .run(
      "s",
      sourceFile(cwd, "s"),
      content,
      `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`,
      cwd,
    );
}

function conversation(cwd: string, status: string, summary: string | null, minute: number): void {
  const at = `2026-11-02T11:${String(minute).padStart(2, "0")}:00Z`;
  getDb()
    .query(
      `INSERT INTO memory_conversations (session_id, source_file, first_message_at, last_message_at, status, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`s${minute}`, sourceFile(cwd, `s${minute}`), at, at, status, summary);
}

describe("memory per workspace", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-workspace-memory-"));
    setDbPathForTests(join(tempDir, "anima.test.db"));
    const db = getDb();
    migrate(db);
    db.query("INSERT INTO workspaces (id, name, cwd) VALUES ('ws_proj', 'proj', ?)").run(ROOT);
    db.query("INSERT INTO workspaces (id, name, cwd) VALUES ('ws_other', 'other', ?)").run(OTHER);
    const folder = db.query(
      "INSERT OR IGNORE INTO workspace_folders (path, workspace_id, kind, inactive_at) VALUES (?, ?, ?, ?)",
    );
    folder.run(ROOT, "ws_proj", "root", null);
    folder.run(WORKTREE, "ws_proj", "worktree", null);
    folder.run(MOVED, "ws_proj", "added", "2026-11-01T00:00:00Z");
    folder.run(OTHER, "ws_other", "root", null);
    const session = db.query(
      `INSERT INTO sessions (workspace_id, provider_session_id, model, purpose, cwd)
       VALUES ('ws_proj', ?, 'test-model', ?, ?)`,
    );
    session.run("sub-chat", "chat", SUBFOLDER);
    // A subagent's folder isn't one of the workspace's, and a session filed
    // here before #107 that ran in another workspace's folder isn't either.
    session.run("sub-agent", "subagent", "/tmp/elsewhere");
    session.run("stray", "chat", OTHER);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds every folder of the workspace from any of them", () => {
    const all = [ROOT, WORKTREE, MOVED, SUBFOLDER];
    expect(workspaceFoldersFor(WORKTREE).sort()).toEqual(all.sort());
    expect(workspaceFoldersFor(ROOT).sort()).toEqual(all.sort());
    // A subfolder is found through its sessions, and comes first.
    expect(workspaceFoldersFor(SUBFOLDER)[0]).toBe(SUBFOLDER);
    expect(workspaceFoldersFor(SUBFOLDER).sort()).toEqual(all.sort());
  });

  it("treats a folder in no workspace as just itself", () => {
    expect(workspaceFoldersFor("/somewhere/else")).toEqual(["/somewhere/else"]);
  });

  it("returns recent messages from all of the workspace's folders", () => {
    entry(ROOT, "in the root", 1);
    entry(WORKTREE, "in the worktree", 2);
    entry(OTHER, "another project", 3);

    const messages = getRecentTranscriptEntries(workspaceFoldersFor(WORKTREE), 10);
    expect(messages.map((m) => m.content)).toEqual(["in the root", "in the worktree"]);
  });

  it("returns summaries from all of the workspace's folders", () => {
    conversation(ROOT, "archived", "root work", 1);
    conversation(MOVED, "archived", "before the move", 2);
    conversation(OTHER, "archived", "another project", 3);

    const summaries = getRecentArchivedSummaries(workspaceFoldersFor(ROOT).map(pattern), 10);
    expect(summaries.map((s) => s.summary)).toEqual(["root work", "before the move"]);
  });

  it("hands every folder's open conversations to Libby", () => {
    conversation(ROOT, "active", null, 1);
    conversation(WORKTREE, "active", null, 2);
    conversation(OTHER, "active", null, 3);

    expect(transitionActiveConversationsByCwd(workspaceFoldersFor(WORKTREE).map(pattern))).toBe(2);
    expect(transitionActiveConversationsByCwd([])).toBe(0);
  });
});
