-- Up

-- Deleting a workspace hides it instead of removing the row. Its sessions
-- keep pointing at it (the foreign key that made a hard delete fail), and
-- creating a workspace at the same folder again brings it back with its id,
-- project fields and history intact. NULL means live.
ALTER TABLE workspaces ADD COLUMN deleted_at TEXT;

-- Down

ALTER TABLE workspaces DROP COLUMN deleted_at;
