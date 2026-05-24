-- Allow auto-emitted reports (attached on task completion by the orchestra
-- scheduler) to coexist with researcher-flow reports in the same table.
--
-- Auto-reports have no user-supplied prompt and no human creator, so
-- `prompt` and `created_by` become nullable. A new `source` discriminator
-- makes intent explicit: 'researcher' (existing flow) vs 'auto'
-- (emitted on StepOutcome::AllDone).
ALTER TABLE diraigent.report
    ALTER COLUMN prompt DROP NOT NULL,
    ALTER COLUMN created_by DROP NOT NULL,
    ADD COLUMN source text NOT NULL DEFAULT 'researcher';

CREATE INDEX idx_report_source ON diraigent.report (source);
CREATE INDEX idx_report_task_id ON diraigent.report (task_id);
