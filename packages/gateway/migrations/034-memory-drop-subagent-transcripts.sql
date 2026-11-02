-- Up

-- Subagent transcripts stay out of Libby's memory (#107): a subagent's work
-- reaches memory through the summary it reports to its parent. Ingest now
-- skips any session whose purpose isn't `chat`; this takes out the ones that
-- got in before it did. Conversations Libby already archived (or is
-- processing) are left alone; only her unwritten queue is cleared.

DELETE FROM memory_conversations
WHERE status IN ('active', 'ready', 'queued')
  AND session_id IN (SELECT provider_session_id FROM sessions WHERE purpose != 'chat');

DELETE FROM memory_transcript_entries
WHERE session_id IN (SELECT provider_session_id FROM sessions WHERE purpose != 'chat');

-- Down

-- Nothing to restore: re-ingesting these transcripts is the bug this fixes.
SELECT 1;
