-- ADR 0001: persist the Claude Code session id per task so the next
-- spawn (next pipeline step, QA re-run, orchestra restart) can resume
-- the same conversation when context.session_mode = "shared".
--
-- Stored as a column rather than nested in `context` JSONB to keep
-- runtime state separate from user intent — a UI re-save of `context`
-- must not be able to clobber an in-flight session pointer.
ALTER TABLE diraigent.task
    ADD COLUMN session_id uuid;

-- Partial index — almost every task will be NULL (per_step mode is
-- the default), so indexing only the populated rows keeps the index
-- tiny while still allowing fast "find task by session" lookups if
-- ever needed for diagnostics.
CREATE INDEX idx_task_session_id ON diraigent.task (session_id)
    WHERE session_id IS NOT NULL;
