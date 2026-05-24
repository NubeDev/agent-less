-- SoW-4: per-QA outcome telemetry so we can later tune `min_confidence`
-- and compare accept modes empirically.
--
-- `outcome` is set independently of `status`:
--   - `unknown` (default): no signal yet
--   - `resolved_clean`: task reached `done`, N days passed, no revert, no follow-up
--   - `resolved_reverted`: task was reverted after the QA was answered
--   - `resolved_followup`: a follow-up observation was created with
--     `source_task_id = this task` after the QA was answered
--
-- Only `status = 'resolved'` rows participate in the outcome lifecycle;
-- everything else stays at `unknown` forever.

ALTER TABLE diraigent.task_qa_item
    ADD COLUMN outcome text NOT NULL DEFAULT 'unknown'
    CONSTRAINT task_qa_item_outcome_check CHECK (outcome = ANY (ARRAY[
        'unknown'::text,
        'resolved_clean'::text,
        'resolved_reverted'::text,
        'resolved_followup'::text
    ]));

-- Sweeper helper: cheap lookup of resolved QAs by outcome.
CREATE INDEX task_qa_item_status_outcome_idx
    ON diraigent.task_qa_item (status, outcome);
