-- Up

-- Consecutive failed runs before the scheduler notifies Michael.
ALTER TABLE scheduler_tasks ADD COLUMN alert_after_failures INTEGER NOT NULL DEFAULT 1;

-- Down

ALTER TABLE scheduler_tasks DROP COLUMN alert_after_failures;
