use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::path::Path as StdPath;
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;
use crate::authz::{OptionalAgentId, require_membership};
use crate::error::AppError;
use crate::models::{ChangedFileSummary, TaskLogFilters};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/{project_id}/claude-md",
            get(get_claude_md).put(put_claude_md),
        )
        .route("/tasks/{task_id}/files-by-step", get(files_by_step))
}

#[derive(Debug, Serialize)]
pub struct StepFileGroup {
    pub step_name: String,
    pub files: Vec<ChangedFileSummary>,
}

/// Returns changed files grouped by step. Files are bucketed into a step by
/// matching `file.created_at` against the timestamp window of each step's
/// task logs (first-log to next-step's-first-log). Files outside any step
/// window land in a synthetic `"unassigned"` bucket.
///
/// Trade-off (per spec): we derive on demand from existing `changed_files`
/// + `task_logs` instead of persisting a `task_step_snapshot` table. This
/// keeps the schema simple (no migration) at the cost of O(F + L) per call;
/// for the typical few-dozen-files-per-task case this is negligible and
/// avoids double-writing data we already have.
async fn files_by_step(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Path(task_id): Path<Uuid>,
) -> Result<Json<Vec<StepFileGroup>>, AppError> {
    let task = state.db.get_task_by_id(task_id).await?;
    require_membership(state.db.as_ref(), agent_id, user_id, task.project_id).await?;

    let mut files = state.db.list_changed_files(task_id).await?;
    files.sort_by_key(|f| f.created_at);

    let logs = state
        .db
        .list_task_logs(
            task.project_id,
            &TaskLogFilters {
                task_id: Some(task_id),
                step_name: None,
                limit: Some(1000),
                offset: None,
            },
        )
        .await?;

    // Build step windows: first task_log timestamp per step name, ordered.
    use std::collections::BTreeMap;
    let mut first_seen: BTreeMap<String, chrono::DateTime<chrono::Utc>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut logs_sorted = logs;
    logs_sorted.sort_by_key(|l| l.created_at);
    for log in &logs_sorted {
        first_seen.entry(log.step_name.clone()).or_insert_with(|| {
            order.push(log.step_name.clone());
            log.created_at
        });
    }

    // Build (step_name, start_ts) list ordered by start_ts
    let mut windows: Vec<(String, chrono::DateTime<chrono::Utc>)> =
        order.iter().map(|s| (s.clone(), first_seen[s])).collect();
    windows.sort_by_key(|w| w.1);

    let mut buckets: BTreeMap<String, Vec<ChangedFileSummary>> = BTreeMap::new();
    for (name, _) in &windows {
        buckets.insert(name.clone(), Vec::new());
    }
    buckets.insert("unassigned".to_string(), Vec::new());

    for f in files {
        // Find the latest window with start_ts <= f.created_at
        let mut assigned: Option<&str> = None;
        for (name, ts) in windows.iter().rev() {
            if *ts <= f.created_at {
                assigned = Some(name.as_str());
                break;
            }
        }
        let key = assigned.unwrap_or("unassigned").to_string();
        buckets.entry(key).or_default().push(f);
    }

    // Emit groups in step order, plus unassigned last (only if non-empty)
    let mut out: Vec<StepFileGroup> = windows
        .into_iter()
        .map(|(name, _)| StepFileGroup {
            files: buckets.remove(&name).unwrap_or_default(),
            step_name: name,
        })
        .collect();
    if let Some(rest) = buckets.remove("unassigned") {
        if !rest.is_empty() {
            out.push(StepFileGroup {
                step_name: "unassigned".to_string(),
                files: rest,
            });
        }
    }
    Ok(Json(out))
}

#[derive(Debug, Serialize)]
pub struct ClaudeMdResponse {
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Deserialize)]
pub struct ClaudeMdUpdate {
    pub content: String,
}

async fn get_claude_md(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ClaudeMdResponse>, AppError> {
    require_membership(state.db.as_ref(), agent_id, user_id, project_id).await?;
    let repo_root = match state.repo_root.as_ref() {
        Some(r) => r,
        None => {
            return Ok(Json(ClaudeMdResponse {
                content: String::new(),
                exists: false,
            }));
        }
    };

    let claude_md_path = repo_root.join("CLAUDE.md");
    match tokio::fs::read_to_string(&claude_md_path).await {
        Ok(content) => Ok(Json(ClaudeMdResponse {
            content,
            exists: true,
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Json(ClaudeMdResponse {
            content: String::new(),
            exists: false,
        })),
        Err(e) => Err(AppError::Internal(format!("Failed to read CLAUDE.md: {e}"))),
    }
}

async fn put_claude_md(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    OptionalAgentId(agent_id): OptionalAgentId,
    Path(project_id): Path<Uuid>,
    Json(req): Json<ClaudeMdUpdate>,
) -> Result<Json<ClaudeMdResponse>, AppError> {
    require_membership(state.db.as_ref(), agent_id, user_id, project_id).await?;

    let repo_root = state.repo_root.as_ref().ok_or_else(|| {
        AppError::ServiceUnavailable(
            "REPO_ROOT not configured — file operations unavailable".into(),
        )
    })?;

    let claude_md_path = repo_root.join("CLAUDE.md");

    // Validate path stays within repo root (prevent traversal)
    let canonical_root = StdPath::new(repo_root)
        .canonicalize()
        .map_err(|e| AppError::Internal(format!("Cannot resolve repo root: {e}")))?;

    // For new files, canonicalize the parent
    let parent = claude_md_path
        .parent()
        .ok_or_else(|| AppError::Internal("Invalid path".into()))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| AppError::Internal(format!("Cannot resolve path: {e}")))?;

    if !canonical_parent.starts_with(&canonical_root) {
        return Err(AppError::Validation("Path traversal not allowed".into()));
    }

    tokio::fs::write(&claude_md_path, &req.content)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write CLAUDE.md: {e}")))?;

    Ok(Json(ClaudeMdResponse {
        content: req.content,
        exists: true,
    }))
}
