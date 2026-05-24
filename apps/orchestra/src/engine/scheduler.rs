//! Reaping finished workers and processing their outcomes (merge, cleanup, etc.).

use std::path::Path;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::config::{ActiveTasks, LockQueue};
use crate::engine::pipeline::{self, StepOutcome};
use crate::engine::reports as report_gen;
use crate::engine::task_source::TaskSource;
use crate::git::ChangedFile;
use crate::git::strategy::GitAction;
use crate::project::paths as project_paths;
use crate::task_id::TaskId;
/// UI-gap #6: extract `task.context.preserve_worktree` (boolean) from a
/// loaded task JSON. Pure helper so the parsing rules are testable.
/// Accepts both `true` and the string `"true"`/`"1"` for robustness, since
/// the UI form may serialize from a checkbox into either shape.
pub(crate) fn preserve_worktree_from_task(task: &serde_json::Value) -> bool {
    let v = &task["context"]["preserve_worktree"];
    v.as_bool().unwrap_or_else(|| match v.as_str() {
        Some(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"),
        None => false,
    })
}

/// Fetch the task and return whether the user requested that the worktree be
/// preserved after the run completes. A failed fetch is treated as "do not
/// preserve" so a transient API error never leaks worktrees indefinitely.
async fn task_requests_preserve_worktree(api: &dyn TaskSource, task_id: &str) -> bool {
    match api.get_task(task_id).await {
        Ok(t) => preserve_worktree_from_task(&t),
        Err(_) => false,
    }
}

/// ADR 0002 Tier 1: parsed `task.context.verifications` slice.
/// Only `extra_test_cmd` and `fail_fast` are actioned in Tier 1; `ids`
/// is intentionally Tier 3 and parsed nowhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerificationsPolicy {
    pub extra_test_cmd: String,
    pub fail_fast: bool,
}

/// Pure parser for `task.context.verifications`. Returns `None` when there
/// is no actionable `extra_test_cmd` (missing block, missing field, empty /
/// whitespace-only string, or non-string type) so the caller can skip the
/// runner entirely without paying for a process spawn.
pub(crate) fn verifications_policy_from_task(
    task: &serde_json::Value,
) -> Option<VerificationsPolicy> {
    let v = &task["context"]["verifications"];
    if !v.is_object() {
        return None;
    }
    let cmd = v["extra_test_cmd"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if cmd.is_empty() {
        return None;
    }
    let ff = &v["fail_fast"];
    let fail_fast = ff.as_bool().unwrap_or_else(|| match ff.as_str() {
        Some(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"),
        None => false,
    });
    Some(VerificationsPolicy {
        extra_test_cmd: cmd,
        fail_fast,
    })
}

/// Truncate a captured stream to a fixed tail so a verbose test suite never
/// blows up the `evidence` JSONB column. Keeps the *end* of the stream,
/// where the failure message usually lives.
fn truncate_stream(s: &str) -> String {
    const MAX: usize = 4096;
    if s.len() <= MAX {
        s.to_string()
    } else {
        let tail = &s[s.len() - MAX..];
        format!("…[truncated {} bytes]…\n{tail}", s.len() - MAX)
    }
}

/// Run the user's `extra_test_cmd` inside the task worktree and record the
/// outcome as a `diraigent.verification` row via `api.create_verification`.
/// Returns `true` when the command succeeded (exit 0), `false` otherwise.
///
/// Best-effort everywhere: a spawn failure, timeout, or DB write failure is
/// logged and degrades to "verification failed" / "not recorded"; the caller
/// continues based on the boolean.
async fn run_extra_test_cmd_and_record(
    api: &dyn TaskSource,
    project_id: &str,
    task_id: &str,
    worktree: &Path,
    cmd: &str,
) -> bool {
    use std::time::Instant;
    use tokio::process::Command;

    info!(
        "task {task_id}: running extra_test_cmd in {}",
        worktree.display()
    );
    let start = Instant::now();
    let spawn = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(worktree)
        .output();

    // Hard timeout so a hung test command can't wedge the scheduler.
    const TIMEOUT_SECS: u64 = 600;
    let result = tokio::time::timeout(std::time::Duration::from_secs(TIMEOUT_SECS), spawn).await;
    let duration_ms = start.elapsed().as_millis() as u64;

    let (passed, exit_code, stdout, stderr) = match result {
        Ok(Ok(o)) => {
            let code = o.status.code().unwrap_or(-1);
            let passed = o.status.success();
            (
                passed,
                code,
                truncate_stream(&String::from_utf8_lossy(&o.stdout)),
                truncate_stream(&String::from_utf8_lossy(&o.stderr)),
            )
        }
        Ok(Err(e)) => {
            warn!("task {task_id}: extra_test_cmd spawn failed: {e}");
            (false, -1, String::new(), format!("spawn failed: {e}"))
        }
        Err(_) => {
            warn!(
                "task {task_id}: extra_test_cmd timed out after {TIMEOUT_SECS}s — recording fail"
            );
            (
                false,
                -1,
                String::new(),
                format!("timed out after {TIMEOUT_SECS}s"),
            )
        }
    };

    let status = if passed { "pass" } else { "fail" };
    let body = serde_json::json!({
        "task_id": task_id,
        "kind": "test",
        "status": status,
        "title": "extra_test_cmd",
        "detail": cmd,
        "evidence": {
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "stdout": stdout,
            "stderr": stderr,
        }
    });
    if let Err(e) = api.create_verification(project_id, &body).await {
        warn!("task {task_id}: failed to record verification row: {e}");
    }
    passed
}

/// UI-gap #6: emit one report row per kind listed in `task.context.reports`,
/// after the AllDone branch has finished merge/cleanup. Best-effort —
/// individual failures (generator data fetch, POST) are logged but do not
/// block other reports or the task lifecycle.
///
/// `diff_data` is `Some(...)` only on the merge path where the branch was
/// inspected before deletion; on no-merge strategies the diff_summary
/// generator is skipped (the branch may still exist but mid-flight diff
/// stats are no longer meaningful at the completion boundary).
async fn emit_requested_reports(
    api: &dyn TaskSource,
    project_id: &str,
    task_id: &str,
    diff_data: Option<(&[ChangedFile], usize, usize)>,
) {
    let task = match api.get_task(task_id).await {
        Ok(t) => t,
        Err(e) => {
            warn!("emit_reports {task_id}: failed to load task: {e} — skipping");
            return;
        }
    };

    let kinds = report_gen::requested_kinds(&task);
    if kinds.is_empty() {
        return;
    }
    info!(
        "emit_reports {task_id}: generating {} report(s)",
        kinds.len()
    );

    for kind in kinds {
        let generated = match kind.as_str() {
            "diff_summary" => {
                let Some((files, ins, del)) = diff_data else {
                    info!("emit_reports {task_id}: skipping diff_summary (no-merge run)");
                    continue;
                };
                report_gen::diff_summary(files, ins, del)
            }
            "cost_breakdown" => report_gen::cost_breakdown(&task),
            "qa_log" => {
                let items = api
                    .list_qa_items_for_task(task_id, "resolved")
                    .await
                    .unwrap_or_else(|e| {
                        warn!("emit_reports {task_id}: qa_log fetch failed: {e}");
                        vec![]
                    });
                report_gen::qa_log(&items)
            }
            "handover_chain" => {
                let updates = api.get_task_updates(task_id).await.unwrap_or_else(|e| {
                    warn!("emit_reports {task_id}: handover_chain fetch failed: {e}");
                    vec![]
                });
                report_gen::handover_chain(&updates)
            }
            "knowledge_touched" => {
                let related = api.get_related_items(task_id).await.unwrap_or_else(|e| {
                    warn!("emit_reports {task_id}: knowledge_touched fetch failed: {e}");
                    serde_json::json!({})
                });
                report_gen::knowledge_touched(&related)
            }
            _ => continue, // unknown kind already filtered by requested_kinds
        };

        let body = serde_json::json!({
            "task_id": task_id,
            "kind": kind,
            "title": generated.title,
            "result": generated.body,
            "metadata": generated.metadata,
        });
        if let Err(e) = api.post_auto_report(project_id, &body).await {
            warn!("emit_reports {task_id}: post {kind} failed: {e}");
        }
    }
}

/// Collect finished tasks and process them (check pipeline state, merge/cleanup).
/// Returns `true` if any file locks were released (triggers immediate re-poll for queued tasks).
pub async fn reap_finished(
    api: &dyn TaskSource,
    projects_path: &Path,
    active: &ActiveTasks,
    lock_queue: &LockQueue,
) -> bool {
    // Collect finished tasks under a short-lived lock to avoid blocking poll_ready_tasks.
    let finished: Vec<(String, JoinHandle<()>)> = {
        let mut tasks = active.lock().await;
        let finished_ids: Vec<String> = tasks
            .iter()
            .filter(|(_, handle)| handle.is_finished())
            .map(|(id, _)| id.clone())
            .collect();

        finished_ids
            .into_iter()
            .filter_map(|id| tasks.remove(&id).map(|handle| (id, handle)))
            .collect()
    };
    // Lock is dropped here — poll_ready_tasks can proceed concurrently.

    let futures: Vec<_> = finished
        .into_iter()
        .map(|(task_id, handle)| {
            process_reaped_task(api, projects_path, task_id, handle, lock_queue)
        })
        .collect();
    let results = futures_util::future::join_all(futures).await;
    results.iter().any(|released| *released)
}

/// Process a single reaped task: join the handle, check pipeline state, and merge/cleanup.
/// Returns `true` if file locks were released (so queued tasks can be retried).
async fn process_reaped_task(
    api: &dyn TaskSource,
    projects_path: &Path,
    task_id: String,
    handle: JoinHandle<()>,
    lock_queue: &LockQueue,
) -> bool {
    let tid = TaskId::new(task_id.as_str());
    match handle.await {
        Ok(()) => {
            info!("reaped worker {tid}");
        }
        Err(e) => {
            error!("worker {tid} panicked: {e} — skipping pipeline advancement and merge");
            let msg = format!(
                "Worker panicked (JoinHandle error): {e}. \
                 Worktree preserved for inspection. \
                 Pipeline advancement and merge skipped."
            );
            if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                warn!("failed to post blocker comment for {tid}: {comment_err}");
            }
            return false;
        }
    }

    // Check if there's a next pipeline step
    let outcome = match pipeline::check_next_step(api, &task_id, None).await {
        Ok(outcome) => outcome,
        Err(e) => {
            error!(
                "check_next_step API error for {tid}: {e} — skipping merge to avoid pushing incomplete work"
            );
            let msg = format!(
                "Pipeline advancement failed: {e}. \
                 Merge skipped to avoid pushing incomplete work. \
                 Manual intervention may be needed."
            );
            if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                warn!("failed to post pipeline-error comment for {tid}: {comment_err}");
            }
            return false;
        }
    };

    // Track project_id for file lock release on terminal outcomes.
    let mut release_lock_project_id: Option<String> = None;

    match outcome {
        StepOutcome::Continue => {
            tracing::debug!("task {tid} pipeline continues");
        }
        StepOutcome::ContinueWithGitAction {
            project_id,
            git_strategy,
            git_action,
        } => {
            let wm = match project_paths::create_project_wm(api, &project_id, projects_path).await {
                Ok(wm) => wm,
                Err(e) => {
                    error!(
                        "reap {tid}: failed to resolve project WM for {project_id}: {e} — skipping git action"
                    );
                    return false;
                }
            };

            match git_action {
                GitAction::Merge => {
                    let target = git_strategy
                        .merge_target(wm.default_branch())
                        .unwrap_or_else(|| wm.default_branch());
                    // Collect stats before merge (branch is deleted after successful merge)
                    let branch_name = TaskId::new(&task_id).branch_name();
                    let changed_files = wm.collect_changed_files(&task_id).unwrap_or_default();
                    let (insertions, deletions) =
                        wm.diff_insertion_deletion_stats(&task_id).unwrap_or((0, 0));
                    match wm.merge_to_branch(&task_id, target) {
                        Ok(_) => {
                            info!("mid-pipeline merge for {tid} to {target} succeeded");
                            let file_paths: Vec<&str> =
                                changed_files.iter().map(|f| f.path.as_str()).collect();
                            emit_merge_event(
                                api,
                                &project_id,
                                &task_id,
                                &branch_name,
                                target,
                                &file_paths,
                                insertions,
                                deletions,
                            )
                            .await;
                            if task_requests_preserve_worktree(api, &task_id).await {
                                info!(
                                    "mid-pipeline merge for {tid} succeeded; preserve_worktree=true — keeping worktree"
                                );
                            } else {
                                wm.remove_worktree(&task_id);
                            }
                        }
                        Err(e) => {
                            error!("mid-pipeline merge failed for {tid}: {e} — keeping branch");
                            emit_merge_error_event(
                                api,
                                &project_id,
                                &task_id,
                                &branch_name,
                                target,
                                &format!("{e:#}"),
                            )
                            .await;
                            let msg = format!(
                                "Mid-pipeline merge to {target} failed: {e}. \
                                 Worktree preserved for manual resolution."
                            );
                            if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                                warn!(
                                    "failed to post merge-failure comment for {tid}: {comment_err}"
                                );
                            }
                        }
                    }
                }
                GitAction::Push => {
                    if wm.is_git_enabled() {
                        match wm.push_task_branch(&task_id) {
                            Ok(_) => {
                                info!("mid-pipeline push for {tid} succeeded");
                            }
                            Err(e) => {
                                error!("mid-pipeline push failed for {tid}: {e} — continuing");
                                let msg =
                                    format!("Mid-pipeline push failed: {e}. Pipeline continues.");
                                if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                                    warn!(
                                        "failed to post push-failure comment for {tid}: {comment_err}"
                                    );
                                }
                            }
                        }
                    }
                }
                GitAction::None => {}
            }
        }
        StepOutcome::AllDone {
            project_id,
            git_strategy,
        } => {
            release_lock_project_id = Some(project_id.clone());
            let wm = match project_paths::create_project_wm(api, &project_id, projects_path).await {
                Ok(wm) => wm,
                Err(e) => {
                    error!(
                        "reap {tid}: failed to resolve project WM for {project_id}: {e} — skipping merge"
                    );
                    return false;
                }
            };

            // ADR 0002 Tier 1: run `context.verifications.extra_test_cmd`
            // BEFORE the merge so a fail+fail_fast short-circuit can skip
            // merging broken code into the default branch. The worktree is
            // still in place at this point.
            let mut verification_blocked_merge = false;
            if let Ok(task_json) = api.get_task(&task_id).await
                && let Some(policy) = verifications_policy_from_task(&task_json)
            {
                let worktree = wm.worktree_path(&task_id);
                if worktree.exists() {
                    let passed = run_extra_test_cmd_and_record(
                        api,
                        &project_id,
                        &task_id,
                        &worktree,
                        &policy.extra_test_cmd,
                    )
                    .await;
                    if !passed && policy.fail_fast {
                        info!(
                            "task {tid}: extra_test_cmd failed + fail_fast — skipping merge, preserving worktree"
                        );
                        verification_blocked_merge = true;
                        let msg = format!(
                            "extra_test_cmd failed (exit non-zero). fail_fast=true: \
                             skipping merge. Worktree preserved at {} for inspection.",
                            worktree.display()
                        );
                        if let Err(e) = api.post_comment(&task_id, &msg).await {
                            warn!("failed to post verification-failure comment for {tid}: {e}");
                        }
                        if let Err(e) = api.transition_task(&task_id, "human_review").await {
                            warn!(
                                "failed to transition {tid} to human_review after verification fail: {e}"
                            );
                        }
                    }
                } else {
                    warn!(
                        "task {tid}: extra_test_cmd requested but worktree {} missing — skipping",
                        worktree.display()
                    );
                }
            }

            // Diff stats are collected here so they survive both the merge
            // (which deletes the branch) and the auto-report emit below.
            // `None` on no-merge strategies — diff_summary then skips.
            let mut diff_data: Option<(Vec<ChangedFile>, usize, usize)> = None;

            if verification_blocked_merge {
                // Skip the merge / push / cleanup tree entirely. Reports
                // still run below so cost / qa / handover artefacts land.
            } else if git_strategy.should_merge() {
                let target = git_strategy
                    .merge_target(wm.default_branch())
                    .unwrap_or_else(|| wm.default_branch());
                // Collect stats before merge (branch is deleted after successful merge)
                let branch_name = TaskId::new(&task_id).branch_name();
                let changed_files = wm.collect_changed_files(&task_id).unwrap_or_default();
                let (insertions, deletions) =
                    wm.diff_insertion_deletion_stats(&task_id).unwrap_or((0, 0));
                diff_data = Some((changed_files.clone(), insertions, deletions));
                match wm.merge_to_branch(&task_id, target) {
                    Ok(_) => {
                        let file_paths: Vec<&str> =
                            changed_files.iter().map(|f| f.path.as_str()).collect();
                        emit_merge_event(
                            api,
                            &project_id,
                            &task_id,
                            &branch_name,
                            target,
                            &file_paths,
                            insertions,
                            deletions,
                        )
                        .await;
                        if task_requests_preserve_worktree(api, &task_id).await {
                            info!(
                                "task {tid} merge succeeded; preserve_worktree=true — keeping worktree"
                            );
                        } else {
                            wm.remove_worktree(&task_id);
                        }
                    }
                    Err(e) => {
                        error!(
                            "merge failed for {tid}: {e} — keeping branch for manual resolution"
                        );
                        emit_merge_error_event(
                            api,
                            &project_id,
                            &task_id,
                            &branch_name,
                            target,
                            &format!("{e:#}"),
                        )
                        .await;
                        let msg = format!(
                            "Merge to {target} failed: {e}. \
                             Worktree preserved for manual resolution."
                        );
                        if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                            warn!("failed to post merge-failure comment for {tid}: {comment_err}");
                        }
                        // Transition to human_review so the failure is visible in the review queue
                        if let Err(tr_err) = api.transition_task(&task_id, "human_review").await {
                            warn!(
                                "failed to transition {tid} to human_review after merge failure: {tr_err}"
                            );
                        } else {
                            info!("task {tid} moved to human_review after merge failure");
                        }
                    }
                }
            } else if git_strategy.should_push_branch() {
                if wm.is_git_enabled() {
                    match wm.push_task_branch(&task_id) {
                        Ok(_) => {
                            info!("task {tid} branch pushed (branch_only strategy)");
                        }
                        Err(e) => {
                            error!("push task branch failed for {tid}: {e} — keeping branch");
                            let msg = format!(
                                "Push task branch failed: {e}. \
                                 Branch preserved for manual push."
                            );
                            if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                                warn!(
                                    "failed to post push-failure comment for {tid}: {comment_err}"
                                );
                            }
                        }
                    }
                }
            } else if task_requests_preserve_worktree(api, &task_id).await {
                info!(
                    "task {tid} done (no-merge strategy); preserve_worktree=true — keeping worktree"
                );
            } else {
                wm.remove_worktree(&task_id);
            }

            // Emit any reports the user requested via `context.reports`.
            // Runs last so generators see the final task state, after merge
            // / cleanup / worktree decisions. Best-effort: failures are
            // logged inside the helper and never block task completion.
            let diff_ref = diff_data.as_ref().map(|(f, i, d)| (f.as_slice(), *i, *d));
            emit_requested_reports(api, &project_id, &task_id, diff_ref).await;
        }
        StepOutcome::AlreadyReady => {
            tracing::debug!("task {tid} in human_review — no action needed");
        }
        StepOutcome::Cancelled { project_id } => {
            release_lock_project_id = Some(project_id.clone());
            let preserve = task_requests_preserve_worktree(api, &task_id).await;
            let comment = if preserve {
                info!("task {tid} cancelled; preserve_worktree=true — keeping worktree");
                "Task cancelled. Worktree preserved (preserve_worktree=true)."
            } else {
                info!("task {tid} cancelled — removing worktree (no merge)");
                if let Ok(wm) =
                    project_paths::create_project_wm(api, &project_id, projects_path).await
                {
                    wm.remove_worktree(&task_id);
                }
                "Task cancelled. Worktree cleaned up — no merge performed."
            };
            if let Err(e) = api.post_comment(&task_id, comment).await {
                warn!("failed to post cancellation comment for {tid}: {e}");
            }
        }
        StepOutcome::UnexpectedState(state) => {
            warn!("task {tid} in unexpected state '{state}' — skipping merge, keeping worktree");
            let msg = format!(
                "Task in unexpected state \'{state}\' after worker completed — \
                 skipping merge and pipeline advancement. \
                 Worktree preserved for investigation."
            );
            if let Err(comment_err) = api.post_comment(&task_id, &msg).await {
                warn!("failed to post unexpected-state comment for {tid}: {comment_err}");
            }
            // Fetch task to get project_id for lock release
            release_lock_project_id = api
                .get_task(&task_id)
                .await
                .ok()
                .and_then(|t| t["project_id"].as_str().map(|s| s.to_string()));
        }
    }

    // Release file locks for terminal outcomes.
    // Continue/ContinueWithGitAction/AlreadyReady keep locks since the task is still in-pipeline.
    let mut locks_released = false;
    if let Some(ref pid) = release_lock_project_id {
        match api.release_file_locks(pid, &task_id).await {
            Ok(_) => {
                locks_released = true;
                // Clear lock-queue entries for this project so queued tasks retry immediately.
                let mut queue = lock_queue.lock().await;
                let unblocked: Vec<String> = queue
                    .iter()
                    .filter(|(_, entry)| entry.project_id == *pid)
                    .map(|(task_id, _)| task_id.clone())
                    .collect();
                if !unblocked.is_empty() {
                    for id in &unblocked {
                        queue.remove(id);
                    }
                    info!(
                        "reap {tid}: unblocked {} queued task(s) in project {pid}",
                        unblocked.len()
                    );
                }
            }
            Err(e) => {
                warn!("reap {tid}: failed to release file locks: {e}");
            }
        }
    }
    locks_released
}

// ── Git event helpers ──

/// Emit a merge success event with file stats.
#[allow(clippy::too_many_arguments)]
async fn emit_merge_event(
    api: &dyn TaskSource,
    project_id: &str,
    task_id: &str,
    branch: &str,
    target_branch: &str,
    files: &[&str],
    insertions: usize,
    deletions: usize,
) {
    let event = serde_json::json!({
        "kind": "merge",
        "source": "orchestra",
        "title": format!("Merged {branch} → {target_branch}"),
        "severity": "info",
        "related_task_id": task_id,
        "agent_id": api.agent_id(),
        "metadata": {
            "task_id": task_id,
            "branch": branch,
            "target_branch": target_branch,
            "files_changed": files.len(),
            "files": files,
            "insertions": insertions,
            "deletions": deletions,
        }
    });
    if let Err(e) = api.post_event(project_id, &event).await {
        warn!("failed to emit merge event: {e}");
    }
}

/// Emit an error event for a failed merge (conflict).
async fn emit_merge_error_event(
    api: &dyn TaskSource,
    project_id: &str,
    task_id: &str,
    branch: &str,
    target_branch: &str,
    error_message: &str,
) {
    let event = serde_json::json!({
        "kind": "error",
        "source": "orchestra",
        "title": format!("Merge conflict: {branch} → {target_branch}"),
        "severity": "warning",
        "related_task_id": task_id,
        "agent_id": api.agent_id(),
        "metadata": {
            "task_id": task_id,
            "branch": branch,
            "target_branch": target_branch,
            "error_message": error_message,
        }
    });
    if let Err(e) = api.post_event(project_id, &event).await {
        warn!("failed to emit merge error event: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProjectsApi;
    use crate::config::{ActiveTasks, LockQueue};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn new_lock_queue() -> LockQueue {
        Arc::new(Mutex::new(HashMap::new()))
    }

    // ── UI-gap #6: preserve_worktree extraction ─────────────────

    #[test]
    fn preserve_worktree_false_when_missing() {
        let task = serde_json::json!({"context": {}});
        assert!(!preserve_worktree_from_task(&task));
    }

    #[test]
    fn preserve_worktree_false_when_no_context() {
        let task = serde_json::json!({});
        assert!(!preserve_worktree_from_task(&task));
    }

    #[test]
    fn preserve_worktree_bool_true() {
        let task = serde_json::json!({"context": {"preserve_worktree": true}});
        assert!(preserve_worktree_from_task(&task));
    }

    #[test]
    fn preserve_worktree_bool_false() {
        let task = serde_json::json!({"context": {"preserve_worktree": false}});
        assert!(!preserve_worktree_from_task(&task));
    }

    #[test]
    fn preserve_worktree_string_true_variants() {
        for s in ["true", "TRUE", " True ", "1", "yes", "YES"] {
            let task = serde_json::json!({"context": {"preserve_worktree": s}});
            assert!(
                preserve_worktree_from_task(&task),
                "expected true for {s:?}"
            );
        }
    }

    #[test]
    fn preserve_worktree_string_falsey_variants() {
        for s in ["false", "0", "no", "", "maybe"] {
            let task = serde_json::json!({"context": {"preserve_worktree": s}});
            assert!(
                !preserve_worktree_from_task(&task),
                "expected false for {s:?}"
            );
        }
    }

    #[test]
    fn preserve_worktree_rejects_unexpected_types() {
        for v in [
            serde_json::json!(1),
            serde_json::json!(0),
            serde_json::json!(null),
            serde_json::json!([true]),
            serde_json::json!({"on": true}),
        ] {
            let task = serde_json::json!({"context": {"preserve_worktree": v}});
            assert!(!preserve_worktree_from_task(&task));
        }
    }

    // ── ADR 0002 Tier 1: verifications policy parser ────────────

    #[test]
    fn verifications_none_when_block_missing() {
        let task = serde_json::json!({"context": {}});
        assert!(verifications_policy_from_task(&task).is_none());
    }

    #[test]
    fn verifications_none_when_no_context() {
        let task = serde_json::json!({});
        assert!(verifications_policy_from_task(&task).is_none());
    }

    #[test]
    fn verifications_none_when_cmd_empty_or_missing() {
        for ctx in [
            serde_json::json!({"verifications": {}}),
            serde_json::json!({"verifications": {"extra_test_cmd": ""}}),
            serde_json::json!({"verifications": {"extra_test_cmd": "   "}}),
            serde_json::json!({"verifications": {"extra_test_cmd": 42}}),
            serde_json::json!({"verifications": {"fail_fast": true}}),
        ] {
            let task = serde_json::json!({"context": ctx});
            assert!(
                verifications_policy_from_task(&task).is_none(),
                "expected None for {ctx}"
            );
        }
    }

    #[test]
    fn verifications_parses_cmd_and_default_fail_fast_false() {
        let task = serde_json::json!({
            "context": {"verifications": {"extra_test_cmd": "pnpm test"}}
        });
        let p = verifications_policy_from_task(&task).expect("policy");
        assert_eq!(p.extra_test_cmd, "pnpm test");
        assert!(!p.fail_fast);
    }

    #[test]
    fn verifications_fail_fast_bool_true() {
        let task = serde_json::json!({
            "context": {"verifications": {
                "extra_test_cmd": "make test",
                "fail_fast": true
            }}
        });
        let p = verifications_policy_from_task(&task).expect("policy");
        assert!(p.fail_fast);
    }

    #[test]
    fn verifications_fail_fast_stringy_variants() {
        for s in ["true", "TRUE", " True ", "1", "yes", "YES"] {
            let task = serde_json::json!({
                "context": {"verifications": {
                    "extra_test_cmd": "go test ./...",
                    "fail_fast": s
                }}
            });
            let p = verifications_policy_from_task(&task).expect("policy");
            assert!(p.fail_fast, "fail_fast should be true for {s:?}");
        }
    }

    #[test]
    fn verifications_fail_fast_falsey_or_unexpected() {
        for v in [
            serde_json::json!(false),
            serde_json::json!("false"),
            serde_json::json!("0"),
            serde_json::json!("maybe"),
            serde_json::json!(null),
            serde_json::json!(1),
        ] {
            let task = serde_json::json!({
                "context": {"verifications": {
                    "extra_test_cmd": "true",
                    "fail_fast": v
                }}
            });
            let p = verifications_policy_from_task(&task).expect("policy");
            assert!(!p.fail_fast, "fail_fast should be false for {v}");
        }
    }

    #[test]
    fn verifications_trims_cmd_whitespace() {
        let task = serde_json::json!({
            "context": {"verifications": {"extra_test_cmd": "  pnpm test  "}}
        });
        let p = verifications_policy_from_task(&task).expect("policy");
        assert_eq!(p.extra_test_cmd, "pnpm test");
    }

    #[test]
    fn verifications_block_must_be_object() {
        for v in [
            serde_json::json!("pnpm test"),
            serde_json::json!(["pnpm test"]),
            serde_json::json!(42),
            serde_json::json!(null),
        ] {
            let task = serde_json::json!({"context": {"verifications": v}});
            assert!(
                verifications_policy_from_task(&task).is_none(),
                "expected None for non-object verifications {v}"
            );
        }
    }

    /// Mount a project mock that returns git_mode="none" so create_project_wm
    /// produces a disabled WM. Task JSON must include `project_id` matching this.
    async fn mount_nogit_project(server: &MockServer, project_id: &str) {
        Mock::given(method("GET"))
            .and(path(format!("/{project_id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": project_id,
                "slug": "test-project",
                "git_mode": "none",
                "metadata": {}
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn concurrent_reap_does_not_block_poll() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({
                        "id": "task-1", "state": "done", "playbook_id": null, "playbook_step": 0,
                        "project_id": "proj-1"
                    }))
                    .set_delay(std::time::Duration::from_millis(200)),
            )
            .mount(&server)
            .await;

        mount_nogit_project(&server, "proj-1").await;

        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = crate::config::Config {
            agent_id: "test-agent".to_string(),
            project_id: Some("proj-1".to_string()),
            diraigent_api: server.uri(),
            max_workers: 4,
            projects_path: std::env::temp_dir(),
            poll_interval: 30,
            agent_cli: "agent-cli".to_string(),
            log_dir: std::env::temp_dir().join("logs"),
            lockfile: std::env::temp_dir().join(".orchestra.pid"),
            worker_model: None,
            dek: None,
            max_implement_cycles: 3,
            indexer_interval: 120,
            orchestration_mode: crate::config::OrchestrationMode::Api,
            data_dir: std::env::temp_dir(),
        };
        let pp = config.projects_path.clone();
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        {
            let mut tasks = active.lock().await;
            tasks.insert("task-1".to_string(), tokio::spawn(async {}));
        }
        tokio::task::yield_now().await;

        let reap_api = Arc::clone(&api);
        let reap_active = Arc::clone(&active);
        let reap_handle = tokio::spawn(async move {
            reap_finished(reap_api.as_ref(), &pp, &reap_active, &new_lock_queue()).await;
        });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let poll_api = Arc::clone(&api);
        let poll_active = Arc::clone(&active);
        let projects: Vec<serde_json::Value> = vec![];
        let poll_result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            crate::engine::spawner::poll_ready_tasks_with_projects(
                &poll_api,
                &config,
                &poll_active,
                &new_lock_queue(),
                &projects,
            ),
        )
        .await;

        assert!(poll_result.is_ok());
        reap_handle.await.unwrap();
    }

    #[tokio::test]
    async fn reap_finished_panic_posts_comment_no_merge() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/comments"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&server)
            .await;

        let api = ProjectsApi::new(&server.uri(), "test-agent");
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        {
            let mut tasks = active.lock().await;
            tasks.insert(
                "task-1".to_string(),
                tokio::spawn(async { panic!("simulated worker panic") }),
            );
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        reap_finished(&api, &std::env::temp_dir(), &active, &new_lock_queue()).await;

        let tasks = active.lock().await;
        assert!(tasks.is_empty());
    }

    #[tokio::test]
    async fn reap_finished_check_next_step_err_no_merge() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/comments"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        let api = ProjectsApi::new(&server.uri(), "test-agent");
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        {
            let mut tasks = active.lock().await;
            tasks.insert("task-1".to_string(), tokio::spawn(async {}));
        }
        tokio::task::yield_now().await;

        reap_finished(&api, &std::env::temp_dir(), &active, &new_lock_queue()).await;

        let tasks = active.lock().await;
        assert!(tasks.is_empty());
    }

    #[tokio::test]
    async fn reap_finished_all_done_nogit_cleans_worktree() {
        let server = MockServer::start().await;
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "task-1", "state": "done", "playbook_id": null, "playbook_step": 0,
                "project_id": project_id,
            })))
            .mount(&server)
            .await;

        mount_nogit_project(&server, project_id).await;

        let tmp = tempfile::tempdir().unwrap();
        let worktree_path = tmp.path().join("worktrees").join("task-task-1");
        std::fs::create_dir_all(&worktree_path).unwrap();
        assert!(worktree_path.exists());

        let api = ProjectsApi::new(&server.uri(), "test-agent");
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        {
            let mut tasks = active.lock().await;
            tasks.insert("task-1".to_string(), tokio::spawn(async {}));
        }
        tokio::task::yield_now().await;

        reap_finished(&api, tmp.path(), &active, &new_lock_queue()).await;

        assert!(!worktree_path.exists());
    }

    #[tokio::test]
    async fn reap_finished_cancelled_removes_worktree_no_merge() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "state": "cancelled", "playbook_id": null, "playbook_step": 0,
                "project_id": project_id,
            })))
            .mount(&server)
            .await;

        mount_nogit_project(&server, project_id).await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/comments"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        let api = ProjectsApi::new(&server.uri(), "test-agent");

        let tmp = tempfile::tempdir().unwrap();
        let wt_dir = tmp.path().join("worktrees").join("task-task-1");
        std::fs::create_dir_all(&wt_dir).unwrap();
        assert!(wt_dir.exists());

        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut tasks = active.lock().await;
            tasks.insert(task_id.to_string(), tokio::spawn(async {}));
        }
        tokio::task::yield_now().await;

        reap_finished(&api, tmp.path(), &active, &new_lock_queue()).await;

        assert!(!wt_dir.exists());
        let tasks = active.lock().await;
        assert!(tasks.is_empty());
    }

    #[tokio::test]
    async fn reap_finished_clears_lock_queue_on_lock_release() {
        let server = MockServer::start().await;
        let project_id = "proj-1";

        // Task that is done → triggers lock release
        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "task-1", "state": "done", "playbook_id": null, "playbook_step": 0,
                "project_id": project_id,
            })))
            .mount(&server)
            .await;

        mount_nogit_project(&server, project_id).await;

        // Lock release succeeds
        Mock::given(method("DELETE"))
            .and(path("/proj-1/locks/task-1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"released": 1})),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = ProjectsApi::new(&server.uri(), "test-agent");
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));
        let lock_queue = new_lock_queue();

        // Pre-populate lock queue with a task blocked on the same project
        {
            let mut queue = lock_queue.lock().await;
            queue.insert(
                "blocked-task-1".to_string(),
                crate::config::LockQueueEntry {
                    project_id: project_id.to_string(),
                    queued_at: std::time::Instant::now(),
                },
            );
            // Also add a task from a different project (should NOT be cleared)
            queue.insert(
                "other-project-task".to_string(),
                crate::config::LockQueueEntry {
                    project_id: "proj-2".to_string(),
                    queued_at: std::time::Instant::now(),
                },
            );
        }

        // Insert a finished task
        {
            let mut tasks = active.lock().await;
            tasks.insert("task-1".to_string(), tokio::spawn(async {}));
        }
        tokio::task::yield_now().await;

        let locks_released = reap_finished(&api, &std::env::temp_dir(), &active, &lock_queue).await;

        // Should return true (locks were released)
        assert!(locks_released);

        // Blocked task for proj-1 should be removed from queue
        let queue = lock_queue.lock().await;
        assert!(
            !queue.contains_key("blocked-task-1"),
            "blocked task for same project should be dequeued"
        );
        // Task from different project should remain
        assert!(
            queue.contains_key("other-project-task"),
            "task from different project should remain in queue"
        );
    }
}
