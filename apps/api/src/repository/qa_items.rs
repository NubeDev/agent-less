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
