use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, http::StatusCode};
use futures::StreamExt;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/review/stream/ticket", post(issue_ticket))
        .route("/review/stream", get(review_stream))
        .route("/agents/stream/ticket", post(issue_agent_ticket))
        .route("/agents/stream", get(agent_stream))
        .route("/tasks/{task_id}/stream/ticket", post(issue_task_ticket))
        .route("/tasks/{task_id}/stream", get(task_stream))
}

/// Request a short-lived opaque ticket for the SSE stream.
///
/// The browser `EventSource` API cannot set custom headers, so a Bearer token
/// must not be placed directly in the URL. Instead, the client:
/// 1. Calls this endpoint with a normal `Authorization: Bearer` header to get a ticket.
/// 2. Opens the EventSource with `?ticket=<uuid>` — an opaque, single-use, 60-second token.
///
/// This keeps the full JWT out of server logs, browser history, and proxy logs.
async fn issue_ticket(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> Result<Json<TicketResponse>, StatusCode> {
    let ticket = state.sse_tickets.issue(user_id).await;
    Ok(Json(TicketResponse { ticket }))
}

#[derive(Serialize)]
struct TicketResponse {
    ticket: Uuid,
}

#[derive(Deserialize)]
struct TicketQuery {
    ticket: Uuid,
}

/// SSE endpoint that streams `review_update` events whenever a task enters or
/// leaves `human_review`.  The web client subscribes on page load instead of
/// polling every 30 s.
///
/// Authentication: short-lived opaque ticket obtained from
/// `POST /review/stream/ticket`. The ticket is consumed on first use and
/// expires after 60 seconds.
async fn review_stream(
    State(state): State<AppState>,
    Query(params): Query<TicketQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    // Consume the ticket — single-use, 60-second TTL.
    state
        .sse_tickets
        .consume(params.ticket)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let rx = state.review_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| async move {
        match result {
            Ok(event) => {
                let data = serde_json::to_string(&event).ok()?;
                Some(Ok::<Event, Infallible>(
                    Event::default().event("review_update").data(data),
                ))
            }
            // Lagged: subscriber fell behind; skip rather than disconnect.
            Err(_) => None,
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

/// Issue a short-lived ticket for the agent status SSE stream.
async fn issue_agent_ticket(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> Result<Json<TicketResponse>, StatusCode> {
    let ticket = state.sse_tickets.issue(user_id).await;
    Ok(Json(TicketResponse { ticket }))
}

/// SSE endpoint that streams `agent_update` events whenever an agent's status
/// changes (heartbeat, update). The web client subscribes instead of polling
/// every 30 s to keep the agent-indicator accurate in real time.
///
/// Authentication: short-lived opaque ticket from `POST /agents/stream/ticket`.
async fn agent_stream(
    State(state): State<AppState>,
    Query(params): Query<TicketQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    state
        .sse_tickets
        .consume(params.ticket)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let rx = state.agent_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| async move {
        match result {
            Ok(event) => {
                let data = serde_json::to_string(&event).ok()?;
                Some(Ok::<Event, Infallible>(
                    Event::default().event("agent_update").data(data),
                ))
            }
            Err(_) => None,
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

/// Per-task live update event sent over `/v1/tasks/{task_id}/stream`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskStreamEvent {
    TaskUpdated {
        task_id: Uuid,
        state: String,
        playbook_step: Option<i32>,
        updated_at: String,
        cost_usd: f64,
        input_tokens: i64,
        output_tokens: i64,
    },
    QaUpdated {
        qa_id: Uuid,
        status: String,
        step_name: String,
    },
    ReportUpdated {
        report_id: Uuid,
        status: String,
    },
    LogAdded {
        log_id: Uuid,
        step_name: String,
        created_at: String,
    },
}

/// Issue a short-lived ticket for the per-task SSE stream.
async fn issue_task_ticket(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> Result<Json<TicketResponse>, StatusCode> {
    let ticket = state.sse_tickets.issue(user_id).await;
    Ok(Json(TicketResponse { ticket }))
}

/// SSE endpoint that streams live updates for a single task.
///
/// Reuses the existing SSE/ticket infrastructure. Implemented as a
/// per-connection 1 s poll over the task/QA/report/task-log rows so the
/// Job Theatre DAG can transition node colours in place without a layout
/// reflow. Only diffs are emitted, so an idle task ships only the 15 s
/// keep-alive frames.
async fn task_stream(
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
    Query(params): Query<TicketQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    state
        .sse_tickets
        .consume(params.ticket)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let initial_task = state
        .db
        .get_task_by_id(task_id)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let project_id = initial_task.project_id;

    let db = state.db.clone();
    let pool = state.pool.clone();

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(32);

    tokio::spawn(async move {
        let mut last_state: Option<String> = None;
        let mut last_step: Option<i32> = None;
        let mut last_updated: Option<String> = None;
        let mut seen_qa: std::collections::HashMap<Uuid, String> = std::collections::HashMap::new();
        let mut seen_reports: std::collections::HashMap<Uuid, String> =
            std::collections::HashMap::new();
        let mut seen_logs: std::collections::HashSet<Uuid> = std::collections::HashSet::new();

        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            if let Ok(t) = db.get_task_by_id(task_id).await {
                let updated_at = t.updated_at.to_rfc3339();
                let changed = last_state.as_deref() != Some(t.state.as_str())
                    || last_step != t.playbook_step
                    || last_updated.as_deref() != Some(updated_at.as_str());
                if changed {
                    last_state = Some(t.state.clone());
                    last_step = t.playbook_step;
                    last_updated = Some(updated_at.clone());
                    let ev = TaskStreamEvent::TaskUpdated {
                        task_id: t.id,
                        state: t.state,
                        playbook_step: t.playbook_step,
                        updated_at,
                        cost_usd: t.cost_usd,
                        input_tokens: t.input_tokens,
                        output_tokens: t.output_tokens,
                    };
                    if let Ok(data) = serde_json::to_string(&ev) {
                        if tx
                            .send(Ok::<Event, Infallible>(
                                Event::default().event("task_update").data(data),
                            ))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }

            // QA: track pending items for this task. We query directly via the
            // shared pool since DiraigentDb doesn't expose an all-statuses list
            // by task.
            if let Ok(qa_rows) = sqlx::query_as::<_, (Uuid, String, String)>(
                "SELECT id, status, step_name FROM diraigent.task_qa_item WHERE task_id = $1",
            )
            .bind(task_id)
            .fetch_all(&pool)
            .await
            {
                for (id, status, step_name) in qa_rows {
                    if seen_qa.get(&id).map(String::as_str) != Some(status.as_str()) {
                        seen_qa.insert(id, status.clone());
                        let ev = TaskStreamEvent::QaUpdated {
                            qa_id: id,
                            status,
                            step_name,
                        };
                        if let Ok(data) = serde_json::to_string(&ev) {
                            if tx
                                .send(Ok::<Event, Infallible>(
                                    Event::default().event("task_update").data(data),
                                ))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }

            if let Ok(Some(r)) = db.get_report_by_task_id(task_id).await {
                if seen_reports.get(&r.id).map(String::as_str) != Some(r.status.as_str()) {
                    seen_reports.insert(r.id, r.status.clone());
                    let ev = TaskStreamEvent::ReportUpdated {
                        report_id: r.id,
                        status: r.status,
                    };
                    if let Ok(data) = serde_json::to_string(&ev) {
                        if tx
                            .send(Ok::<Event, Infallible>(
                                Event::default().event("task_update").data(data),
                            ))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }

            let log_filters = crate::models::TaskLogFilters {
                task_id: Some(task_id),
                step_name: None,
                limit: Some(50),
                offset: Some(0),
            };
            if let Ok(logs) = db.list_task_logs(project_id, &log_filters).await {
                for l in logs {
                    if seen_logs.insert(l.id) {
                        let ev = TaskStreamEvent::LogAdded {
                            log_id: l.id,
                            step_name: l.step_name,
                            created_at: l.created_at.to_rfc3339(),
                        };
                        if let Ok(data) = serde_json::to_string(&ev) {
                            if tx
                                .send(Ok::<Event, Infallible>(
                                    Event::default().event("task_update").data(data),
                                ))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }
        }
    });

    let s = tokio_stream::wrappers::ReceiverStream::new(rx);

    Ok(Sse::new(s).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}
