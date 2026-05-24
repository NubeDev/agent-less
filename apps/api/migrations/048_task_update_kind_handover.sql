-- SoW-3: add `handover` to task_update.kind enum.
--
-- A handover row is the agent's structured close-out for a step. The next
-- step's prompt prepends the most recent handover so successive steps do
-- not need to re-derive prior decisions from the worktree.

ALTER TABLE diraigent.task_update
    DROP CONSTRAINT IF EXISTS task_update_kind_check;

ALTER TABLE diraigent.task_update
    ADD CONSTRAINT task_update_kind_check
    CHECK (kind = ANY (ARRAY[
        'progress'::text,
        'blocker'::text,
        'question'::text,
        'artifact'::text,
        'review'::text,
        'note'::text,
        'handover'::text
    ]));
