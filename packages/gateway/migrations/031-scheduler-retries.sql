-- Up

-- Extra attempts after a failed run, and the wait before the first one (doubles each time).
ALTER TABLE scheduler_tasks ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_tasks ADD COLUMN retry_delay_seconds INTEGER NOT NULL DEFAULT 10;

-- Down

ALTER TABLE scheduler_tasks DROP COLUMN retry_delay_seconds;
ALTER TABLE scheduler_tasks DROP COLUMN retries;
