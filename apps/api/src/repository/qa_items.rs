//! Repository for `task_qa_item` rows — structured questions raised by an
//! agent step via the `DIRAIGENT_QA` sentinel (SoW-1).
//!
//! Mirrors the shape of `observations.rs`: thin CRUD helpers that take a
//! `&PgPool` and return domain models. Higher-level wiring (auth, state
//! transitions, SSE broadcast) lives in `routes/qa.rs`.

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{CreateTaskQaItem, TaskQaItem, TaskQaItemFilters};

pub async fn create_qa_item(pool: &PgPool, req: &CreateTaskQaItem) -> Result<TaskQaItem, AppError> {
    let kind = req.kind.as_deref().unwrap_or("question");
    let responder = req.responder.as_deref().unwrap_or("human");
    let metadata = req.metadata.clone().unwrap_or(serde_json::json!({}));

    let row = sqlx::query_as::<_, TaskQaItem>(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, options,
              responder, expires_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *",
    )
    .bind(req.task_id)
    .bind(req.project_id)
    .bind(&req.step_name)
    .bind(kind)
    .bind(&req.prompt)
    .bind(&req.options)
    .bind(responder)
    .bind(req.expires_at)
    .bind(&metadata)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

pub async fn get_qa_item(pool: &PgPool, id: Uuid) -> Result<TaskQaItem, AppError> {
    sqlx::query_as::<_, TaskQaItem>("SELECT * FROM diraigent.task_qa_item WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("QA item not found".into()))
}

pub async fn list_qa_items_by_task(
    pool: &PgPool,
    task_id: Uuid,
) -> Result<Vec<TaskQaItem>, AppError> {
    let rows = sqlx::query_as::<_, TaskQaItem>(
        "SELECT * FROM diraigent.task_qa_item WHERE task_id = $1 ORDER BY created_at ASC",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_pending_qa_items(
    pool: &PgPool,
    filters: &TaskQaItemFilters,
) -> Result<Vec<TaskQaItem>, AppError> {
    let status = filters.status.as_deref().unwrap_or("pending");
    let limit = filters.limit.unwrap_or(100).clamp(1, 500);
    let offset = filters.offset.unwrap_or(0).max(0);

    let rows = sqlx::query_as::<_, TaskQaItem>(
        "SELECT * FROM diraigent.task_qa_item
         WHERE status = $1
           AND ($2::uuid IS NULL OR task_id = $2)
           AND ($3::uuid IS NULL OR project_id = $3)
         ORDER BY created_at ASC
         LIMIT $4 OFFSET $5",
    )
    .bind(status)
    .bind(filters.task_id)
    .bind(filters.project_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Set the answer on a QA item. Transitions `status` to `answered` and
/// stamps `answered_at`. Does NOT change task state — the caller is
/// responsible for the downstream state transition (typically via
/// `set_qa_item_status` after the task transition succeeds).
pub async fn set_qa_item_answer(
    pool: &PgPool,
    id: Uuid,
    answer: &str,
    answered_by: &str,
) -> Result<TaskQaItem, AppError> {
    let row = sqlx::query_as::<_, TaskQaItem>(
        "UPDATE diraigent.task_qa_item
         SET answer = $2,
             answered_by = $3,
             status = 'answered',
             answered_at = $4
         WHERE id = $1
         RETURNING *",
    )
    .bind(id)
    .bind(answer)
    .bind(answered_by)
    .bind(Utc::now())
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Transition the status of a QA item directly. When transitioning to
/// `resolved`, also stamps `resolved_at`.
pub async fn set_qa_item_status(
    pool: &PgPool,
    id: Uuid,
    status: &str,
) -> Result<TaskQaItem, AppError> {
    let resolved_at = if status == "resolved" {
        Some(Utc::now())
    } else {
        None
    };
    let row = sqlx::query_as::<_, TaskQaItem>(
        "UPDATE diraigent.task_qa_item
         SET status = $2,
             resolved_at = COALESCE($3, resolved_at)
         WHERE id = $1
         RETURNING *",
    )
    .bind(id)
    .bind(status)
    .bind(resolved_at)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// SoW-2 timeout sweeper: select every pending, AI-targeted QA item
/// whose `expires_at` has elapsed and mark it `escalated`.
///
/// Returns the rows that were transitioned so the caller can fan out
/// the matching task transitions (ai_review -> human_review) and write
/// audit `task_update`s. Human-targeted items are NEVER selected — a
/// human must always answer their own QAs.
pub async fn escalate_expired_ai_qa(pool: &PgPool) -> Result<Vec<TaskQaItem>, AppError> {
    let rows = sqlx::query_as::<_, TaskQaItem>(
        "UPDATE diraigent.task_qa_item
         SET status = 'escalated'
         WHERE status = 'pending'
           AND responder = 'ai'
           AND expires_at IS NOT NULL
           AND expires_at < now()
         RETURNING *",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// SoW-4 outcome hook: stamp every resolved QA on this task as the
/// given outcome, but only when the row is still at `outcome = 'unknown'`
/// so the first decisive signal wins (a revert beats a follow-up if
/// both happen).
pub async fn set_qa_outcome_for_task(
    pool: &PgPool,
    task_id: Uuid,
    outcome: &str,
) -> Result<u64, AppError> {
    let res = sqlx::query(
        "UPDATE diraigent.task_qa_item
         SET outcome = $2
         WHERE task_id = $1
           AND status = 'resolved'
           AND outcome = 'unknown'",
    )
    .bind(task_id)
    .bind(outcome)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// SoW gap #9: when a task is cancelled, cascade every still-`pending`
/// QA on it to `resolved` with `metadata.cancellation_reason =
/// "task_cancelled"`. The `answer` field is stamped with a marker
/// string so the existing review UI renders a clear "no answer
/// needed" entry instead of a perpetual pending. Idempotent: a second
/// call is a no-op because rows are no longer `pending`.
///
/// Outcome is left at `'unknown'` deliberately — a cancelled task
/// gives no signal about whether the QA itself was good or bad, and
/// SoW-4 telemetry should not be polluted with cancellation noise.
pub async fn resolve_pending_qa_for_cancelled_task(
    pool: &PgPool,
    task_id: Uuid,
) -> Result<u64, AppError> {
    let res = sqlx::query(
        "UPDATE diraigent.task_qa_item
         SET status      = 'resolved',
             answer      = COALESCE(answer, '[task cancelled — no answer needed]'),
             answered_at = COALESCE(answered_at, now()),
             resolved_at = COALESCE(resolved_at, now()),
             metadata    = metadata || jsonb_build_object('cancellation_reason', 'task_cancelled')
         WHERE task_id = $1
           AND status = 'pending'",
    )
    .bind(task_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Resolve every other pending QA on the same task as a side-effect
/// of answering one. Used by the QA answer route: when the agent
/// emitted N sentinels in a single step, answering any one transitions
/// the task out of `ai_review`, which would otherwise strand the
/// siblings as pending-but-unanswerable (422 on every subsequent
/// answer attempt because the task is no longer in a review state).
///
/// Each sibling is stamped with `answer = '[batched with QA <primary>]'`
/// and `metadata.batched_with = <primary>` so reviewers can trace the
/// resolution back to the primary answer. Outcome stays `'unknown'`
/// (SoW-4 telemetry shouldn't infer good/bad from a batch close).
///
/// Returns the count of rows affected. Excludes the primary QA itself.
pub async fn resolve_sibling_pending_qa(
    pool: &PgPool,
    task_id: Uuid,
    primary_qa_id: Uuid,
) -> Result<u64, AppError> {
    let marker = format!("[batched with QA {primary_qa_id}]");
    let res = sqlx::query(
        "UPDATE diraigent.task_qa_item
         SET status      = 'resolved',
             answer      = COALESCE(answer, $3),
             answered_at = COALESCE(answered_at, now()),
             resolved_at = COALESCE(resolved_at, now()),
             metadata    = metadata || jsonb_build_object('batched_with', $2::text)
         WHERE task_id = $1
           AND id != $2
           AND status = 'pending'",
    )
    .bind(task_id)
    .bind(primary_qa_id)
    .bind(&marker)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// been `done` for at least `min_age_days` and still has
/// `outcome = 'unknown'`, set the outcome to `resolved_clean`.
///
/// Returns the count of rows updated. Safe to run as often as desired:
/// once a row leaves `unknown` it is no longer matched.
pub async fn sweep_clean_qa_outcome(pool: &PgPool, min_age_days: i32) -> Result<u64, AppError> {
    let res = sqlx::query(
        "UPDATE diraigent.task_qa_item q
         SET outcome = 'resolved_clean'
         FROM diraigent.task t
         WHERE q.task_id = t.id
           AND q.status = 'resolved'
           AND q.outcome = 'unknown'
           AND t.state = 'done'
           AND t.reverted_at IS NULL
           AND t.updated_at < now() - make_interval(days => $1)",
    )
    .bind(min_age_days)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// SoW gap #11: aggregate QA velocity & quality metrics over the last
/// `window_days`, optionally scoped to a project. Single SQL roundtrip;
/// returns a JSON blob the route serializes verbatim.
///
/// Counters: total + by_status + by_responder + by_kind + by_outcome.
/// Timing: human and AI answer-latency seconds (avg / p50 / p95) over
///         rows where `responder = x AND status = 'resolved' AND
///         answered_at IS NOT NULL AND created_at IS NOT NULL`.
/// Ratios: accept_rate    = clean / (clean + reverted + followup)
///         escalation_rate = escalated / total
///         expiration_rate = expired / total
pub async fn qa_velocity_metrics(
    pool: &PgPool,
    project_id: Option<Uuid>,
    window_days: i32,
) -> Result<serde_json::Value, AppError> {
    // Single CTE: scope rows once, then aggregate from the CTE.
    // Using `extract(epoch from …)` for second-precision floats; the
    // route can round in the UI if it cares.
    let row: (serde_json::Value,) = sqlx::query_as(
        r#"
        WITH scoped AS (
            SELECT *
            FROM diraigent.task_qa_item
            WHERE created_at >= now() - make_interval(days => $2)
              AND ($1::uuid IS NULL OR project_id = $1)
        ),
        counts AS (
            SELECT
                count(*) AS total,
                jsonb_object_agg(status,    cnt) FILTER (WHERE status    IS NOT NULL) AS by_status,
                jsonb_object_agg(responder, cnt) FILTER (WHERE responder IS NOT NULL) AS by_responder,
                jsonb_object_agg(kind,      cnt) FILTER (WHERE kind      IS NOT NULL) AS by_kind,
                jsonb_object_agg(outcome,   cnt) FILTER (WHERE outcome   IS NOT NULL) AS by_outcome
            FROM (
                SELECT status, responder, kind, outcome, count(*) AS cnt
                FROM scoped
                GROUP BY GROUPING SETS ((status), (responder), (kind), (outcome))
            ) g
        ),
        human_t AS (
            SELECT
                count(*)::bigint AS n,
                avg(extract(epoch from (resolved_at - created_at)))                    AS avg_s,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (resolved_at - created_at))) AS p50_s,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from (resolved_at - created_at))) AS p95_s
            FROM scoped
            WHERE responder = 'human' AND status = 'resolved'
              AND resolved_at IS NOT NULL AND created_at IS NOT NULL
        ),
        ai_t AS (
            SELECT
                count(*)::bigint AS n,
                avg(extract(epoch from (resolved_at - created_at)))                    AS avg_s,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (resolved_at - created_at))) AS p50_s,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from (resolved_at - created_at))) AS p95_s
            FROM scoped
            WHERE responder = 'ai' AND status = 'resolved'
              AND resolved_at IS NOT NULL AND created_at IS NOT NULL
        ),
        outcome_rates AS (
            SELECT
                sum(CASE WHEN outcome = 'resolved_clean'    THEN 1 ELSE 0 END)::float8 AS clean,
                sum(CASE WHEN outcome = 'resolved_reverted' THEN 1 ELSE 0 END)::float8 AS reverted,
                sum(CASE WHEN outcome = 'resolved_followup' THEN 1 ELSE 0 END)::float8 AS followup,
                sum(CASE WHEN status  = 'escalated'         THEN 1 ELSE 0 END)::float8 AS escalated,
                sum(CASE WHEN status  = 'expired'           THEN 1 ELSE 0 END)::float8 AS expired,
                count(*)::float8 AS total
            FROM scoped
        ),
        ai_conf AS (
            -- gap #11 follow-up: AI-confidence distribution. Worker
            -- stamps metadata.ai_confidence on every auto-answered QA
            -- (accept or escalate), so this includes rows whose
            -- status is 'resolved' OR 'escalated' as long as the
            -- metadata was set. NULL when no auto-answer ran yet.
            SELECT
                count(*)::bigint AS n,
                avg((metadata->>'ai_confidence')::float8)                                                                       AS avg_c,
                percentile_cont(0.5)  WITHIN GROUP (ORDER BY (metadata->>'ai_confidence')::float8)                              AS p50_c,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (metadata->>'ai_confidence')::float8)                              AS p95_c,
                -- 5 bins of width 0.2 over [0.0, 1.0]; the >=1.0 edge
                -- folds into the top bucket so we never lose rows.
                sum(CASE WHEN (metadata->>'ai_confidence')::float8 <  0.2                                        THEN 1 ELSE 0 END)::bigint AS bin_0_0_0_2,
                sum(CASE WHEN (metadata->>'ai_confidence')::float8 >= 0.2 AND (metadata->>'ai_confidence')::float8 < 0.4 THEN 1 ELSE 0 END)::bigint AS bin_0_2_0_4,
                sum(CASE WHEN (metadata->>'ai_confidence')::float8 >= 0.4 AND (metadata->>'ai_confidence')::float8 < 0.6 THEN 1 ELSE 0 END)::bigint AS bin_0_4_0_6,
                sum(CASE WHEN (metadata->>'ai_confidence')::float8 >= 0.6 AND (metadata->>'ai_confidence')::float8 < 0.8 THEN 1 ELSE 0 END)::bigint AS bin_0_6_0_8,
                sum(CASE WHEN (metadata->>'ai_confidence')::float8 >= 0.8                                        THEN 1 ELSE 0 END)::bigint AS bin_0_8_1_0
            FROM scoped
            WHERE metadata ? 'ai_confidence'
        )
        SELECT jsonb_build_object(
            'window_days',   $2::int,
            'total',         coalesce(counts.total, 0),
            'by_status',     coalesce(counts.by_status,    '{}'::jsonb),
            'by_responder',  coalesce(counts.by_responder, '{}'::jsonb),
            'by_kind',       coalesce(counts.by_kind,      '{}'::jsonb),
            'by_outcome',    coalesce(counts.by_outcome,   '{}'::jsonb),
            'human_answer_seconds', jsonb_build_object(
                'count', coalesce(human_t.n, 0),
                'avg',   human_t.avg_s,
                'p50',   human_t.p50_s,
                'p95',   human_t.p95_s
            ),
            'ai_answer_seconds', jsonb_build_object(
                'count', coalesce(ai_t.n, 0),
                'avg',   ai_t.avg_s,
                'p50',   ai_t.p50_s,
                'p95',   ai_t.p95_s
            ),
            'ai_confidence', jsonb_build_object(
                'count', coalesce(ai_conf.n, 0),
                'avg',   ai_conf.avg_c,
                'p50',   ai_conf.p50_c,
                'p95',   ai_conf.p95_c,
                'histogram', jsonb_build_object(
                    '0.0-0.2', coalesce(ai_conf.bin_0_0_0_2, 0),
                    '0.2-0.4', coalesce(ai_conf.bin_0_2_0_4, 0),
                    '0.4-0.6', coalesce(ai_conf.bin_0_4_0_6, 0),
                    '0.6-0.8', coalesce(ai_conf.bin_0_6_0_8, 0),
                    '0.8-1.0', coalesce(ai_conf.bin_0_8_1_0, 0)
                )
            ),
            'accept_rate',     CASE WHEN (outcome_rates.clean + outcome_rates.reverted + outcome_rates.followup) > 0
                                    THEN outcome_rates.clean / (outcome_rates.clean + outcome_rates.reverted + outcome_rates.followup)
                                    ELSE NULL END,
            'escalation_rate', CASE WHEN outcome_rates.total > 0 THEN outcome_rates.escalated / outcome_rates.total ELSE NULL END,
            'expiration_rate', CASE WHEN outcome_rates.total > 0 THEN outcome_rates.expired   / outcome_rates.total ELSE NULL END
        )
        FROM counts, human_t, ai_t, outcome_rates, ai_conf
        "#,
    )
    .bind(project_id)
    .bind(window_days)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// SoW gap #11 follow-up: stamp the AI responder's reported confidence
/// onto the QA row's `metadata.ai_confidence`. Idempotent overwrite —
/// later passes (e.g. SecondPass) may update with the more recent
/// value; we don't track per-pass history.
///
/// `confidence` is the float emitted by the responder via
/// `<confidence>0.NN</confidence>`. Caller is expected to clamp /
/// validate (route already does).
pub async fn stamp_qa_ai_confidence(
    pool: &PgPool,
    id: Uuid,
    confidence: f64,
) -> Result<TaskQaItem, AppError> {
    let row = sqlx::query_as::<_, TaskQaItem>(
        "UPDATE diraigent.task_qa_item
         SET metadata = metadata || jsonb_build_object('ai_confidence', $2::float8)
         WHERE id = $1
         RETURNING *",
    )
    .bind(id)
    .bind(confidence)
    .fetch_one(pool)
    .await?;
    Ok(row)
}
