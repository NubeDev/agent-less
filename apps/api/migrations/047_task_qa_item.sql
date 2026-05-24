-- SoW-1: structured QA items raised by an agent step.
--
-- When a step emits the DIRAIGENT_QA sentinel in its log, the worker parks
-- the task in `ai_review` and inserts one row here per parsed question.
-- A bridge row in `task_update` (kind = 'question') points at this row via
-- metadata.qa_item_id so the existing review-thread UI surfaces it.
--
-- For SoW-1 every QA is human-responded (responder = 'human').
-- SoW-2 introduces the AI responder; status transitions
-- (`pending` → `answered` → `accepted` → `resolved`, or `escalated`) become
-- meaningful at that point.

CREATE TABLE diraigent.task_qa_item (
    id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    task_id         uuid        NOT NULL REFERENCES diraigent.task(id) ON DELETE CASCADE,
    project_id      uuid        NOT NULL REFERENCES diraigent.project(id) ON DELETE CASCADE,
    step_name       text        NOT NULL,
    kind            text        NOT NULL DEFAULT 'question',
    prompt          text        NOT NULL,
    options         jsonb,
    responder       text        NOT NULL DEFAULT 'human',
    answer          text,
    answered_by     text,
    status          text        NOT NULL DEFAULT 'pending',
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    answered_at     timestamptz,
    resolved_at     timestamptz,
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT task_qa_item_kind_check
        CHECK (kind = ANY (ARRAY['question'::text, 'blocker'::text, 'gate_failure'::text])),
    CONSTRAINT task_qa_item_responder_check
        CHECK (responder = ANY (ARRAY['ai'::text, 'human'::text])),
    CONSTRAINT task_qa_item_status_check
        CHECK (status = ANY (ARRAY[
            'pending'::text,
            'answered'::text,
            'accepted'::text,
            'escalated'::text,
            'resolved'::text
        ]))
);

CREATE INDEX task_qa_item_task_status_idx
    ON diraigent.task_qa_item (task_id, status);

CREATE INDEX task_qa_item_status_expires_idx
    ON diraigent.task_qa_item (status, expires_at)
    WHERE expires_at IS NOT NULL;
