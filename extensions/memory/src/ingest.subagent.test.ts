import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../../packages/gateway/src/db/migrate";
import { closeDb, getDb, setDbPathForTests } from "./db";
import { ingestFile } from "./ingest";

const CHAT_ID = "0a7c1e10-0000-4000-8000-00000000c4a7";
const SUBAGENT_ID = "0a7c1e10-0000-4000-8000-0000000005ab";

function line(sessionId: string, role: "user" | "assistant", text: string, minute: number): string {
  return `${JSON.stringify({
    type: role,
    sessionId,
    cwd: "/repo/project",
    timestamp: `2026-11-02T10:${String(minute).padStart(2, "0")}:00.000Z`,
    message: { role, content: [{ type: "text", text }] },
  })}\n`;
}

function countEntries(sessionId: string): number {
  return (
    getDb()
      .query("SELECT count(*) AS n FROM memory_transcript_entries WHERE session_id = ?")
      .get(sessionId) as { n: number }
  ).n;
}

function countConversations(sessionId: string): number {
  return (
    getDb()
      .query("SELECT count(*) AS n FROM memory_conversations WHERE session_id = ?")
      .get(sessionId) as { n: number }
  ).n;
}

function recordSession(sessionId: string, purpose: string): void {
  const db = getDb();
  db.query(
    "INSERT OR IGNORE INTO workspaces (id, name, cwd) VALUES ('ws_ingest', 'p', '/repo')",
  ).run();
  db.query(
    `INSERT INTO sessions (workspace_id, provider_session_id, model, purpose)
     VALUES ('ws_ingest', ?, 'test-model', ?)`,
  ).run(sessionId, purpose);
}

describe("ingest leaves subagent transcripts out of memory", () => {
  let tempDir: string;
  let basePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-memory-subagent-"));
    setDbPathForTests(join(tempDir, "anima.test.db"));
    migrate(getDb());
    basePath = join(tempDir, "projects");
    mkdirSync(join(basePath, "-repo-project"), { recursive: true });
  });

  afterEach(() => {
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ingests a chat session and skips a subagent", () => {
    recordSession(CHAT_ID, "chat");
    recordSession(SUBAGENT_ID, "subagent");
    const chatFile = join(basePath, "-repo-project", `${CHAT_ID}.jsonl`);
    const subFile = join(basePath, "-repo-project", `${SUBAGENT_ID}.jsonl`);
    writeFileSync(
      chatFile,
      line(CHAT_ID, "user", "hi love", 0) + line(CHAT_ID, "assistant", "hi", 1),
    );
    writeFileSync(
      subFile,
      line(SUBAGENT_ID, "user", "do x", 0) + line(SUBAGENT_ID, "assistant", "done", 1),
    );

    ingestFile(chatFile, basePath, 30);
    ingestFile(subFile, basePath, 30);

    expect(countEntries(CHAT_ID)).toBe(2);
    expect(countEntries(SUBAGENT_ID)).toBe(0);
    expect(countConversations(SUBAGENT_ID)).toBe(0);
  });

  it("takes back lines read before the subagent's session row existed", () => {
    const subFile = join(basePath, "-repo-project", `${SUBAGENT_ID}.jsonl`);
    writeFileSync(subFile, line(SUBAGENT_ID, "user", "do x", 0));
    ingestFile(subFile, basePath, 30);
    expect(countEntries(SUBAGENT_ID)).toBe(1);

    recordSession(SUBAGENT_ID, "subagent");
    appendFileSync(subFile, line(SUBAGENT_ID, "assistant", "done", 1));
    ingestFile(subFile, basePath, 30);

    expect(countEntries(SUBAGENT_ID)).toBe(0);
    expect(countConversations(SUBAGENT_ID)).toBe(0);
  });

  it("treats a transcript with no session row as a chat", () => {
    const file = join(basePath, "-repo-project", `${CHAT_ID}.jsonl`);
    writeFileSync(file, line(CHAT_ID, "user", "plain claude run", 0));
    ingestFile(file, basePath, 30);
    expect(countEntries(CHAT_ID)).toBe(1);
  });
});
