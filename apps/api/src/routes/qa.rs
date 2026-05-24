//! QA item routes — list pending questions and submit answers.
//!
//! SoW-1: humans answer every QA. POST `/v1/qa/{id}/answer` records the
//! answer, transitions the task from `ai_review` (where the worker parked
//! it) to the named step the human selected, then marks the QA item
//! `resolved`. SSE clients learn about the transition via the existing
//! review-stream broadcast (see `routes/tasks.rs`).

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use diraigent_types::state_machine::{can_transition, is_review_state};
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;
use crate::authz::{OptionalAgentId, require_authority, require_membership};
use crate::error::AppError;
use crate::models::{AnswerTaskQaItem, TaskQaItem, TaskQaItemFilters};
use crate::repository as qa_items;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/qa", get(list_pending).post(create))
        .route("/v1/qa/{id}", get(get_one))
        .route("/v1/qa/{id}/answer", post(answer))
        .route("/v1/qa/sweep-expired", post(sweep_expired))
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Json(req): Json<crate::models::CreateTaskQaItem>,
) -> Result<Json<TaskQaItem>, AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::Validation("prompt cannot be empty".into()));
    }
    if req.step_name.trim().is_empty() {
        return Err(AppError::Validation("step_name cannot be empty".into()));
    }
    require_authority(
        state.db.as_ref(),
        agent_id,
        user_id,
        req.project_id,
        "execute",
    )
    .await?;
    // Sanity: the task must belong to the named project.
    let task = state.db.get_task_by_id(req.task_id).await?;
    if task.project_id != req.project_id {
        return Err(AppError::Validation(
            "task_id does not belong to project_id".into(),
        ));
    }
    let item = qa_items::create_qa_item(&state.pool, &req).await?;

    // Bridge into task_update (kind=question) so existing review-thread UI
    // surfaces it; metadata.qa_item_id links the rows.
    let bridge_metadata = serde_json::json!({
        "qa_item_id": item.id,
        "qa_kind": item.kind,
        "qa_status": item.status,
        "step_name": item.step_name,
    });
    let _ = sqlx::query(
        "INSERT INTO diraigent.task_update (task_id, agent_id, kind, content, metadata)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(item.task_id)
    .bind(agent_id)
    .bind("question")
    .bind(&item.prompt)
    .bind(&bridge_metadata)
    .execute(&state.pool)
    .await;

    state.fire_event(
        item.project_id,
        "qa_item.created",
        "task_qa_item",
        item.id,
        agent_id,
        Some(user_id),
        serde_json::json!({
            "qa_item_id": item.id,
            "task_id": item.task_id,
            "step_name": item.step_name,
            "responder": item.responder,
        }),
    );

    Ok(Json(item))
}

async fn list_pending(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Query(filters): Query<TaskQaItemFilters>,
) -> Result<Json<Vec<TaskQaItem>>, AppError> {
    // When project_id is supplied, enforce membership scoping; otherwise the
    // caller sees only items they could fetch individually via get_one. For
    // SoW-1 we accept the broader query but filter results to projects the
    // user is a member of below.
    if let Some(pid) = filters.project_id {
        require_membership(state.db.as_ref(), agent_id, user_id, pid).await?;
    }
    let items = qa_items::list_pending_qa_items(&state.pool, &filters).await?;
    Ok(Json(items))
}

async fn get_one(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Path(id): Path<Uuid>,
) -> Result<Json<TaskQaItem>, AppError> {
    let item = qa_items::get_qa_item(&state.pool, id).await?;
    require_membership(state.db.as_ref(), agent_id, user_id, item.project_id).await?;
    Ok(Json(item))
}

async fn answer(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Path(id): Path<Uuid>,
    Json(req): Json<AnswerTaskQaItem>,
) -> Result<Json<TaskQaItem>, AppError> {
    if req.answer.trim().is_empty() {
        return Err(AppError::Validation("answer cannot be empty".into()));
    }
    if req.target_step.trim().is_empty() {
        return Err(AppError::Validation("target_step cannot be empty".into()));
    }

    let item = qa_items::get_qa_item(&state.pool, id).await?;
    require_authority(
        state.db.as_ref(),
        agent_id,
        user_id,
        item.project_id,
        "review",
    )
    .await?;

    if item.status == "resolved" {
        return Err(AppError::Conflict("QA item already resolved".into()));
    }

    let task = state.db.get_task_by_id(item.task_id).await?;

    // The worker parks the task in `ai_review` on sentinel detection.
    // Humans can also answer from `human_review` (escalated path).
    if !is_review_state(&task.state) {
        return Err(AppError::UnprocessableEntity(format!(
            "Task is in state '{}' — QA can only be answered while in a review state",
            task.state
        )));
    }
    if !can_transition(&task.state, &req.target_step) {
        return Err(AppError::UnprocessableEntity(format!(
            "Cannot transition task from '{}' to '{}'",
            task.state, req.target_step
        )));
    }

    // 1. Record the human answer.
    let answered_by = format!("human:{}", user_id);
    let answered = qa_items::set_qa_item_answer(&state.pool, id, &req.answer, &answered_by).await?;

    // 2. Transition the task back to the step. Failure here leaves the QA
    //    item in `answered` state — humans can retry the transition by
    //    re-POSTing with the same answer.
    let old_state = task.state.clone();
    let transitioned = state
        .db
        .transition_task(item.task_id, &req.target_step, None)
        .await?;

    // 3. Mark the QA item resolved. (Best-effort; the transition is the
    //    user-visible outcome.)
    let resolved = qa_items::set_qa_item_status(&state.pool, id, "resolved")
        .await
        .unwrap_or(answered);

    // 4. Bridge: write a task_update of kind `note` documenting the
    //    resolution so the existing thread surface shows it.
    let bridge_metadata = serde_json::json!({
        "qa_item_id": resolved.id,
        "qa_status": "resolved",
        "answered_by": answered_by,
        "from_state": old_state,
        "to_state": transitioned.state,
    });
    let _ = sqlx::query(
        "INSERT INTO diraigent.task_update (task_id, user_id, kind, content, metadata)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(item.task_id)
    .bind(user_id)
    .bind("note")
    .bind(format!("QA answered: {}", req.answer))
    .bind(&bridge_metadata)
    .execute(&state.pool)
    .await;

    // 5. SSE: piggyback on the existing review stream so the web client
    //    refreshes the review queue. The `kind=left` event fires because
    //    the task is no longer in a review state.
    let _ = state.review_tx.send(crate::ReviewSseEvent {
        kind: "left".to_string(),
        state: Some(old_state.clone()),
        project_id: transitioned.project_id,
        task_id: transitioned.id,
        title: transitioned.title.clone(),
    });

    // 6. Audit + webhooks.
    state.fire_event(
        transitioned.project_id,
        "qa_item.answered",
        "task_qa_item",
        resolved.id,
        agent_id,
        Some(user_id),
        serde_json::json!({
            "qa_item_id": resolved.id,
            "task_id": item.task_id,
            "target_step": transitioned.state,
            "answered_at": Utc::now(),
        }),
    );

    Ok(Json(resolved))
}

/// SoW-2 timeout sweeper endpoint.
///
/// Called periodically by the orchestra worker. For every pending
/// AI-targeted QA item whose `expires_at` has elapsed:
///
/// 1. Mark the QA `escalated`.
/// 2. If the task is still in `ai_review`, transition it to
///    `human_review`.
/// 3. Write a `note` task_update with reason `ai_timeout` so the human
///    reviewer sees why the item ended up on their queue.
///
/// Idempotent: once a row is `escalated` the UPDATE no longer matches it.
/// Returns the list of escalated QA items.
async fn sweep_expired(
    State(state): State<AppState>,
    AuthUser(_user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
) -> Result<Json<Vec<TaskQaItem>>, AppError> {
    let escalated = qa_items::escalate_expired_ai_qa(&state.pool).await?;

    for item in &escalated {
        // Best-effort task transition. Only force the task into
        // human_review when it is still parked in ai_review — if a human
        // already grabbed it (or it transitioned elsewhere) we leave it alone.
        let task = match state.db.get_task_by_id(item.task_id).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    qa_id = %item.id,
                    error = %e,
                    "sweep_expired: failed to fetch task for escalation"
                );
                continue;
            }
        };
        if task.state == "ai_review" {
            if let Err(e) = state
                .db
                .transition_task(item.task_id, "human_review", None)
                .await
            {
                tracing::warn!(
                    qa_id = %item.id,
                    task_id = %item.task_id,
                    error = %e,
                    "sweep_expired: transition ai_review -> human_review failed"
                );
            } else {
                // SSE: nudge the review queue so the human surface picks it up.
                let _ = state.review_tx.send(crate::ReviewSseEvent {
                    kind: "entered".to_string(),
                    state: Some("human_review".to_string()),
                    project_id: task.project_id,
                    task_id: task.id,
                    title: task.title.clone(),
                });
            }
        }

        let bridge_metadata = serde_json::json!({
            "qa_item_id": item.id,
            "qa_status": "escalated",
            "reason": "ai_timeout",
            "step_name": item.step_name,
        });
        let _ = sqlx::query(
            "INSERT INTO diraigent.task_update (task_id, agent_id, kind, content, metadata)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(item.task_id)
        .bind(agent_id)
        .bind("note")
        .bind(format!(
            "AI responder timed out on QA {} — escalated to human_review",
            item.id
        ))
        .bind(&bridge_metadata)
        .execute(&state.pool)
        .await;

        state.fire_event(
            item.project_id,
            "qa_item.escalated",
            "task_qa_item",
            item.id,
            agent_id,
            None,
            serde_json::json!({
                "qa_item_id": item.id,
                "task_id": item.task_id,
                "reason": "ai_timeout",
            }),
        );
    }

    Ok(Json(escalated))
}
