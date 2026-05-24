//! Task claiming, loop detection, and worker spawning.

use tracing::{error, info, warn};

use std::sync::Arc;

use crate::config::{ActiveTasks, Config, LockQueue, LockQueueEntry};
use crate::engine::task_source::TaskSource;
use crate::git::WorktreeManager;

/// How long a task stays in the lock queue before being retried regardless.
const LOCK_QUEUE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
use crate::engine::pipeline;
use crate::engine::step_profile;
use crate::engine::worker;
use crate::git::strategy as git_strategy;
use crate::project::paths as project_paths;
use crate::task_id::TaskId;

pub async fn poll_ready_tasks_with_projects(
    api: &Arc<dyn TaskSource>,
    config: &Config,
    active: &ActiveTasks,
    lock_queue: &LockQueue,
    projects: &[serde_json::Value],
) {
    let tasks = active.lock().await;
    if tasks.len() >= config.max_workers {
        return;
    }
    drop(tasks);

    if projects.is_empty() {
        info!("poll: no projects visible to this agent");
        return;
    }
    info!(
        "poll: scanning {} project(s) for ready tasks",
        projects.len()
    );

    for project in projects {
        let tasks = active.lock().await;
        if tasks.len() >= config.max_workers {
            break;
        }
        drop(tasks);

        let project_id = match project["id"].as_str() {
            Some(id) => id,
            None => continue,
        };

        let ready = match api.get_ready_tasks(project_id).await {
            Ok(t) => t,
            Err(e) => {
                let pname = project["name"]
                    .as_str()
                    .or(project["slug"].as_str())
                    .unwrap_or(project_id);
                warn!("poll: failed to fetch tasks for {pname}: {e}");
                continue;
            }
        };

        if !ready.is_empty() {
            let pname = project["name"]
                .as_str()
                .or(project["slug"].as_str())
                .unwrap_or(project_id);
            info!("poll: {} ready task(s) in {pname}", ready.len());
        }

        for task in &ready {
            let tasks = active.lock().await;
            if tasks.len() >= config.max_workers {
                break;
            }
            let task_id = match task["id"].as_str() {
                Some(id) => id,
                None => continue,
            };
            if tasks.contains_key(task_id) {
                drop(tasks);
                continue;
            }
            drop(tasks);

            // Skip tasks in the lock queue (blocked on file locks).
            // If the TTL expired, remove and retry.
            {
                let mut queue = lock_queue.lock().await;
                if let Some(entry) = queue.get(task_id) {
                    if entry.queued_at.elapsed() < LOCK_QUEUE_TTL {
                        continue; // Still blocked, skip
                    }
                    // TTL expired — remove and retry
                    queue.remove(task_id);
                }
            }

            let title = task["title"].as_str().unwrap_or("");
            let tid = TaskId::new(task_id);
            info!("poll: picked up {tid} \"{title}\"");

            spawn_worker(api, config, active, task_id, project_id, lock_queue).await;
        }
    }
}

/// UI-gap #6: extract per-task model + budget overrides from
/// `task.context`. Pure helper so the precedence rules can be unit
/// tested without spinning up the full spawner.
///
/// Model precedence: `context.model_override` (UI canonical, UI-4) >
/// `context.model` (legacy). Empty / non-string values are dropped.
///
/// Budget cap: `context.budget_usd_cap` if finite and `> 0`; the
/// caller clamps the resolved step budget against this cap and never
/// raises it.
pub(crate) fn task_overrides_from_context(
    task: Option<&serde_json::Value>,
) -> (Option<String>, Option<f64>) {
    let Some(task) = task else {
        return (None, None);
    };
    let ctx = &task["context"];
    let model = ctx["model_override"]
        .as_str()
        .or_else(|| ctx["model"].as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let budget_cap = ctx["budget_usd_cap"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0);
    (model, budget_cap)
}

/// ADR 0001: extract `context.session_mode` from a loaded task JSON.
/// Returns `true` only for the literal string `"shared"`; everything
/// else (missing field, `"per_step"`, non-string, typos) means the
/// default per-step behaviour.
pub(crate) fn session_mode_is_shared(task: Option<&serde_json::Value>) -> bool {
    task.and_then(|t| t["context"]["session_mode"].as_str())
        .map(|s| s.trim().eq_ignore_ascii_case("shared"))
        .unwrap_or(false)
}

/// ADR 0001: resolve the session handle for this spawn. Returns
/// `None` for `per_step` mode (the default). Returns `Some` for
/// `shared` mode — either reusing the existing `task.session_id` or
/// allocating a fresh UUID and persisting it via the API. The
/// `is_first_spawn` flag distinguishes which Claude CLI flag the
/// provider should use (`--session-id` vs `--resume`).
///
/// Persistence happens BEFORE the spawn returns so a crashed-spawn
/// replay never orphans the prior session. Persistence failure
/// degrades gracefully to per_step rather than blocking the task —
/// session reuse is a UX optimisation, not a correctness requirement.
pub(crate) async fn build_session_handle(
    api: &dyn TaskSource,
    task: Option<&serde_json::Value>,
    task_id: &str,
) -> Option<crate::providers::SessionHandle> {
    if !session_mode_is_shared(task) {
        return None;
    }

    let existing = task
        .and_then(|t| t["session_id"].as_str())
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    if let Some(id) = existing {
        return Some(crate::providers::SessionHandle {
            id,
            is_first_spawn: false,
        });
    }

    let id = uuid::Uuid::new_v4();
    match api.set_task_session(task_id, &id.to_string()).await {
        Ok(_) => Some(crate::providers::SessionHandle {
            id,
            is_first_spawn: true,
        }),
        Err(e) => {
            tracing::warn!(
                "spawn {task_id}: session_mode=shared but set_task_session failed: {e} — falling back to per_step for this spawn"
            );
            None
        }
    }
}

pub async fn spawn_worker(
    api: &Arc<dyn TaskSource>,
    config: &Config,
    active: &ActiveTasks,
    task_id: &str,
    project_id: &str,
    lock_queue: &LockQueue,
) {
    let tid = TaskId::new(task_id);

    // Fetch task for title, per-task model override, and step resolution
    let task_data = match api.get_task(task_id).await {
        Ok(data) => Some(data),
        Err(e) => {
            warn!("spawn {tid}: failed to fetch task data: {e} — proceeding with defaults");
            None
        }
    };
    let title = task_data
        .as_ref()
        .and_then(|t| t["title"].as_str().map(|s| s.to_string()))
        .unwrap_or_default();

    // Resolve per-project paths early so we can use git_root for repo playbook resolution.
    let (git_mode, git_root, working_dir, auto_push, default_branch, upload_logs, store_diffs) =
        match project_paths::resolve_project_paths(api.as_ref(), project_id, &config.projects_path)
            .await
        {
            Ok(paths) => (
                paths.git_mode,
                paths.git_root,
                paths.working_dir,
                paths.auto_push,
                paths.default_branch,
                paths.upload_logs,
                paths.store_diffs,
            ),
            Err(e) => {
                warn!("spawn {tid}: failed to resolve project paths: {e}");
                (
                    "standalone".to_string(),
                    Some(config.projects_path.clone()),
                    config.projects_path.clone(),
                    false,
                    "main".to_string(),
                    false,
                    false,
                )
            }
        };

    // Resolve playbook step (name + full JSONB config), with repo playbook override support
    let (step_name, step_json) =
        pipeline::resolve_step(api.as_ref(), task_data.as_ref(), git_root.as_deref()).await;

    // Resolve effective max_cycles: step JSON > project metadata > global config.
    let project_max_cycles = pipeline::resolve_max_implement_cycles(
        api.as_ref(),
        project_id,
        config.max_implement_cycles,
    )
    .await;
    let effective_max_cycles = step_json
        .as_ref()
        .and_then(|s| s["max_cycles"].as_u64())
        .map(|v| v as u32)
        .unwrap_or(project_max_cycles);

    // Loop detection: cancel tasks that have failed too many times.
    let step_retriable = step_json
        .as_ref()
        .map(step_profile::is_retriable)
        .unwrap_or_else(|| {
            step_profile::StepProfile::for_step(&step_name) == step_profile::StepProfile::Implement
        });
    if effective_max_cycles > 0 && step_retriable {
        let cycles = pipeline::count_blocker_cycles(api.as_ref(), task_id).await;
        if cycles >= effective_max_cycles {
            warn!(
                "loop-detect {tid}: {cycles} failed implement cycles (max={effective_max_cycles}), cancelling",
            );
            let reason = format!(
                "Needs human review: {cycles} failed implement cycles (threshold: {effective_max_cycles}).",
            );
            if let Err(e) = api.post_task_update(task_id, "blocker", &reason).await {
                warn!("loop-detect {tid}: failed to post blocker: {e}");
            }
            if let Err(e) = api.transition_task(task_id, "ready").await {
                warn!("loop-detect {tid}: failed to release task: {e}");
            } else {
                worker::post_worker_event(
                    api.as_ref(),
                    project_id,
                    task_id,
                    &format!("Loop detected: task {tid} released for human review"),
                    "warn",
                    serde_json::json!({
                        "failed_cycles": cycles,
                        "max_implement_cycles": effective_max_cycles,
                        "step": step_name,
                    }),
                )
                .await;
            }
            return;
        }
    }

    // Extract context.files for file lock acquisition
    let context_files: Vec<String> = task_data
        .as_ref()
        .and_then(|t| t["context"]["files"].as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // Acquire file locks if the task declares file scope
    if !context_files.is_empty() {
        match api
            .acquire_file_locks(project_id, task_id, &context_files)
            .await
        {
            Ok(_) => {
                info!(
                    "spawn {tid}: acquired file locks for {} path(s)",
                    context_files.len()
                );
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if msg.contains("409") {
                    info!("spawn {tid}: queued — file scope conflicts with active task");
                    let mut queue = lock_queue.lock().await;
                    queue.insert(
                        task_id.to_string(),
                        LockQueueEntry {
                            project_id: project_id.to_string(),
                            queued_at: std::time::Instant::now(),
                        },
                    );
                } else {
                    warn!("spawn {tid}: failed to acquire file locks: {msg} — skipping spawn");
                }
                return;
            }
        }
    }

    // Per-task model + budget overrides from task.context (UI-4
    // advanced overrides). Extracted to a pure helper so we can unit-test
    // the precedence rules without standing up a full spawn.
    let (task_model, task_budget_cap) = task_overrides_from_context(task_data.as_ref());

    // ADR 0001: resolve session reuse policy. For per_step (default)
    // this is None and providers spawn fresh each time; for shared,
    // this allocates a stable UUID on first spawn and reuses it on
    // every subsequent spawn within the task.
    let session_handle = build_session_handle(api.as_ref(), task_data.as_ref(), task_id).await;

    // Build step-specific config from playbook JSONB with hardcoded fallbacks
    let mut step_config = worker::StepConfig::for_step(
        &step_name,
        step_json.as_ref(),
        task_model.as_deref(),
        config.worker_model.as_deref(),
    );

    // Apply per-task budget cap as a clamp (task overrides downward only).
    if let Some(cap) = task_budget_cap {
        step_config.budget = Some(match step_config.budget {
            Some(b) if b > 0.0 => b.min(cap),
            _ => cap,
        });
    }

    // Resolve git strategy from playbook metadata
    let git_strategy =
        git_strategy::resolve_strategy(api.as_ref(), task_data.as_ref(), &git_mode).await;

    let model_info = step_config.model.as_deref().unwrap_or("default");
    info!(
        "spawn {tid}: step={step_name} model={model_info} budget={} tools={} git={}",
        step_config
            .budget
            .map(|b| format!("${b:.1}"))
            .unwrap_or_else(|| "∞".into()),
        step_config.allowed_tools.len(),
        git_strategy.id(),
    );

    // Auto-clone/init repo if it doesn't exist yet
    if git_mode != "none"
        && let Some(ref root) = git_root
        && !root.join(".git").exists()
    {
        info!(
            "spawn {tid}: repo not found at {}, provisioning...",
            root.display()
        );
        if let Ok(project) = api.get_project(project_id).await {
            let repo_url = project["repo_url"].as_str().unwrap_or("");
            let default_branch = project["default_branch"].as_str().unwrap_or("main");
            let slug = project["slug"].as_str().unwrap_or(project_id);
            crate::git::provisioner::provision_repo(root, repo_url, default_branch, slug);
        } else {
            warn!("spawn {tid}: could not fetch project record for git provisioning");
        }
    }

    let api_clone = Arc::clone(api);
    let agent_cli = config.agent_cli.clone();
    let log_dir = config.log_dir.clone();
    let task_id_owned = task_id.to_string();
    let project_id_owned = project_id.to_string();
    let dek = config.dek.clone();

    let handle = tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            // Use strategy's base_branch (falls back to default_branch for Merge)
            let base = git_strategy
                .base_branch(&default_branch)
                .unwrap_or(&default_branch);
            let wm = if git_mode == "none" || git_strategy == crate::git::strategy::GitStrategy::NoGit {
                WorktreeManager::disabled(&working_dir)
            } else if let Some(ref root) = git_root {
                let m = WorktreeManager::with_branch(root, base);
                // For feature_branch, ensure the work branch exists before creating worktrees
                if let crate::git::strategy::GitStrategy::FeatureBranch { work_branch } =
                    &git_strategy
                    && let Err(e) = m.ensure_branch(work_branch)
                {
                    warn!(
                        "spawn: failed to ensure work branch {work_branch} for task {task_id_owned}: {e}"
                    );
                }
                m
            } else {
                WorktreeManager::disabled(&working_dir)
            };
            wm.set_auto_push(auto_push);
            let repo_root_for_worker = git_root.as_deref().unwrap_or(&working_dir);
            match worker::run_worker(
                api_clone.as_ref(),
                &wm,
                &task_id_owned,
                &project_id_owned,
                repo_root_for_worker,
                &agent_cli,
                &log_dir,
                &step_config,
                dek.as_ref(),
                upload_logs,
                store_diffs,
                session_handle.clone(),
            )
            .await
            {
                Ok(result) => {
                    let sid = TaskId::new(task_id_owned.as_str());
                    if result.is_error {
                        error!(
                            "worker {sid} completed with error: stop_reason={} cost=${:.2} turns={} duration={}s",
                            result.stop_reason, result.cost_usd, result.api_turns, result.duration_seconds
                        );
                    }
                }
                Err(e) => {
                    let sid = TaskId::new(task_id_owned.as_str());
                    error!("worker {sid} crashed: {e:#}");

                    // Post blocker so humans can see why the task failed
                    let blocker_msg = format!("Worker crashed: {e:#}");
                    if let Err(be) = api_clone.post_task_update(&task_id_owned, "blocker", &blocker_msg).await {
                        warn!("worker {sid}: failed to post blocker: {be}");
                    }

                    // Transition task to cancelled to prevent infinite crash loop.
                    // Infrastructure errors (worktree creation, git issues) are not
                    // transient — re-picking the task will just crash again.
                    if let Err(te) = api_clone.transition_task(&task_id_owned, "cancelled").await {
                        warn!("worker {sid}: failed to cancel crashed task: {te}");
                    } else {
                        info!("worker {sid}: cancelled crashed task to prevent retry loop");
                    }

                    worker::post_worker_event(
                        api_clone.as_ref(),
                        &project_id_owned,
                        &task_id_owned,
                        &format!("Worker crashed: task {sid}"),
                        "error",
                        serde_json::json!({ "error": format!("{e:#}") }),
                    )
                    .await;
                }
            }
        });
    });

    let count = {
        let mut tasks = active.lock().await;
        tasks.insert(task_id.to_string(), handle);
        tasks.len()
    };

    info!("start {tid} ({count}/{}) \"{title}\"", config.max_workers);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ActiveTasks, Config, LockQueue};
    use crate::project::api::ProjectsApi;
    use std::collections::HashMap;
    use tokio::sync::Mutex;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn new_lock_queue() -> LockQueue {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn standard_playbook() -> serde_json::Value {
        serde_json::json!({
            "id": "pb-1",
            "steps": [
                {"name": "implement", "step": 0},
                {"name": "review", "step": 1},
                {"name": "merge", "step": 2},
                {"name": "dream", "step": 3}
            ]
        })
    }

    fn project_json(metadata: Option<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "id": "proj-1",
            "name": "test-project",
            "slug": "test-project",
            "git_mode": "none",
            "metadata": metadata.unwrap_or(serde_json::json!({}))
        })
    }

    async fn mount_project_mock(server: &MockServer, metadata: Option<serde_json::Value>) {
        Mock::given(method("GET"))
            .and(path("/proj-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(project_json(metadata)))
            .mount(server)
            .await;
    }

    fn test_config(base_url: &str, max_implement_cycles: u32) -> Config {
        Config {
            agent_id: "test-agent".to_string(),
            project_id: Some("proj-1".to_string()),
            diraigent_api: base_url.to_string(),
            max_workers: 4,
            projects_path: std::env::temp_dir(),
            poll_interval: 30,
            agent_cli: "agent-cli".to_string(),
            log_dir: std::env::temp_dir().join("logs"),
            lockfile: std::env::temp_dir().join(".orchestra.pid"),
            worker_model: None,
            dek: None,
            max_implement_cycles,
            indexer_interval: 120,
            orchestration_mode: crate::config::OrchestrationMode::Api,
            data_dir: std::env::temp_dir(),
        }
    }

    #[tokio::test]
    async fn spawn_worker_cancels_at_loop_detect_threshold() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "implement",
                "playbook_id": "pb-1", "playbook_step": 0, "context": {}
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"kind": "blocker", "content": "build failed", "agent_id": "test-agent"},
                {"kind": "blocker", "content": "test failed", "agent_id": "test-agent"},
                {"kind": "blocker", "content": "lint failed", "agent_id": "test-agent"}
            ])))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/transition"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/proj-1/events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        mount_project_mock(&server, None).await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 3);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        spawn_worker(
            &api,
            &config,
            &active,
            task_id,
            project_id,
            &new_lock_queue(),
        )
        .await;

        let tasks = active.lock().await;
        assert!(!tasks.contains_key(task_id));
    }

    #[tokio::test]
    async fn spawn_worker_below_threshold_proceeds_normally() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "implement",
                "playbook_id": "pb-1", "playbook_step": 0, "context": {}
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"kind": "blocker", "content": "build failed", "agent_id": "test-agent"},
                {"kind": "blocker", "content": "test failed", "agent_id": "test-agent"}
            ])))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/transition"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/proj-1/events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        mount_project_mock(&server, None).await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 3);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        spawn_worker(
            &api,
            &config,
            &active,
            task_id,
            project_id,
            &new_lock_queue(),
        )
        .await;
    }

    #[tokio::test]
    async fn spawn_worker_loop_detect_disabled_when_max_cycles_zero() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "implement",
                "playbook_id": "pb-1", "playbook_step": 0, "context": {}
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(0)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/transition"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&server)
            .await;

        mount_project_mock(&server, None).await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 0);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        spawn_worker(
            &api,
            &config,
            &active,
            task_id,
            project_id,
            &new_lock_queue(),
        )
        .await;
    }

    #[tokio::test]
    async fn spawn_worker_review_step_skips_loop_detection() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "review",
                "playbook_id": "pb-1", "playbook_step": 1, "context": {}
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(0)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/transition"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&server)
            .await;

        mount_project_mock(&server, None).await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 3);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        spawn_worker(
            &api,
            &config,
            &active,
            task_id,
            project_id,
            &new_lock_queue(),
        )
        .await;
    }

    #[tokio::test]
    async fn spawn_worker_project_override_max_cycles_1_triggers_cancellation() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "implement",
                "playbook_id": "pb-1", "playbook_step": 0, "context": {}
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        mount_project_mock(
            &server,
            Some(serde_json::json!({"max_implement_cycles": 1})),
        )
        .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"kind": "blocker", "content": "build failed", "agent_id": "test-agent"}
            ])))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/transition"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/proj-1/events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 3);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        spawn_worker(
            &api,
            &config,
            &active,
            task_id,
            project_id,
            &new_lock_queue(),
        )
        .await;

        let tasks = active.lock().await;
        assert!(!tasks.contains_key(task_id));
    }

    #[tokio::test]
    async fn spawn_worker_project_override_max_cycles_0_disables_loop_detection() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "implement",
                "playbook_id": "pb-1", "playbook_step": 0, "context": {}
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        mount_project_mock(
            &server,
            Some(serde_json::json!({"max_implement_cycles": 0})),
        )
        .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(0)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/tasks/task-1/transition"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/proj-1/events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 3);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));

        spawn_worker(
            &api,
            &config,
            &active,
            task_id,
            project_id,
            &new_lock_queue(),
        )
        .await;
    }

    #[tokio::test]
    async fn spawn_worker_queues_task_on_file_lock_conflict() {
        let server = MockServer::start().await;
        let task_id = "task-1";
        let project_id = "proj-1";

        // Task with context.files that will trigger lock acquisition
        Mock::given(method("GET"))
            .and(path("/tasks/task-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": task_id, "title": "Test task", "state": "implement",
                "playbook_id": "pb-1", "playbook_step": 0,
                "context": { "files": ["src/*.rs"] }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/playbooks/pb-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(standard_playbook()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/tasks/task-1/updates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        // Lock acquisition returns 409 conflict
        Mock::given(method("POST"))
            .and(path("/proj-1/locks"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "Path 'src/*.rs' conflicts with existing lock held by task other-task"
            })))
            .expect(1)
            .mount(&server)
            .await;

        mount_project_mock(&server, None).await;

        let api: Arc<dyn TaskSource> = Arc::new(ProjectsApi::new(&server.uri(), "test-agent"));
        let config = test_config(&server.uri(), 3);
        let active: ActiveTasks = Arc::new(Mutex::new(HashMap::new()));
        let lock_queue = new_lock_queue();

        spawn_worker(&api, &config, &active, task_id, project_id, &lock_queue).await;

        // Task should NOT be in active workers (spawn was skipped)
        let tasks = active.lock().await;
        assert!(!tasks.contains_key(task_id));
        drop(tasks);

        // Task SHOULD be in the lock queue
        let queue = lock_queue.lock().await;
        assert!(queue.contains_key(task_id));
        assert_eq!(queue[task_id].project_id, project_id);
    }

    // ── UI-gap #6: model_override + budget_usd_cap ────────────────

    #[test]
    fn task_overrides_none_when_missing_task() {
        let (m, b) = task_overrides_from_context(None);
        assert!(m.is_none());
        assert!(b.is_none());
    }

    #[test]
    fn task_overrides_none_when_context_empty() {
        let task = serde_json::json!({"context": {}});
        let (m, b) = task_overrides_from_context(Some(&task));
        assert!(m.is_none());
        assert!(b.is_none());
    }

    #[test]
    fn task_overrides_model_canonical_wins_over_legacy() {
        let task = serde_json::json!({
            "context": {"model_override": "opus", "model": "sonnet"}
        });
        let (m, _) = task_overrides_from_context(Some(&task));
        assert_eq!(m.as_deref(), Some("opus"));
    }

    #[test]
    fn task_overrides_model_legacy_used_when_canonical_absent() {
        let task = serde_json::json!({"context": {"model": "sonnet"}});
        let (m, _) = task_overrides_from_context(Some(&task));
        assert_eq!(m.as_deref(), Some("sonnet"));
    }

    #[test]
    fn task_overrides_model_whitespace_canonical_dropped() {
        let task = serde_json::json!({
            "context": {"model_override": "   ", "model": "haiku"}
        });
        let (m, _) = task_overrides_from_context(Some(&task));
        // Whitespace-only `model_override` is treated as a present-but-empty
        // value and short-circuits the legacy fallback. UI cannot send this
        // shape (the form trims before persisting), but we document the
        // behaviour explicitly.
        assert!(m.is_none());
    }

    #[test]
    fn task_overrides_budget_cap_valid() {
        let task = serde_json::json!({"context": {"budget_usd_cap": 7.5}});
        let (_, b) = task_overrides_from_context(Some(&task));
        assert_eq!(b, Some(7.5));
    }

    #[test]
    fn task_overrides_budget_cap_rejects_zero_negative_and_non_finite() {
        for v in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let task = serde_json::json!({"context": {"budget_usd_cap": v}});
            let (_, b) = task_overrides_from_context(Some(&task));
            assert!(b.is_none(), "expected None for {v}");
        }
    }

    #[test]
    fn task_overrides_budget_cap_ignored_when_non_numeric() {
        let task = serde_json::json!({"context": {"budget_usd_cap": "5"}});
        let (_, b) = task_overrides_from_context(Some(&task));
        assert!(b.is_none());
    }

    // ── ADR 0001: session_mode parsing ─────────────────────────────

    #[test]
    fn session_mode_default_per_step() {
        assert!(!session_mode_is_shared(None));
        assert!(!session_mode_is_shared(Some(&serde_json::json!({}))));
        assert!(!session_mode_is_shared(Some(
            &serde_json::json!({"context": {}})
        )));
    }

    #[test]
    fn session_mode_per_step_explicit() {
        let task = serde_json::json!({"context": {"session_mode": "per_step"}});
        assert!(!session_mode_is_shared(Some(&task)));
    }

    #[test]
    fn session_mode_shared_recognised() {
        let task = serde_json::json!({"context": {"session_mode": "shared"}});
        assert!(session_mode_is_shared(Some(&task)));
    }

    #[test]
    fn session_mode_case_insensitive_and_trimmed() {
        for v in ["SHARED", " Shared ", "shared"] {
            let task = serde_json::json!({"context": {"session_mode": v}});
            assert!(
                session_mode_is_shared(Some(&task)),
                "expected shared for {v:?}"
            );
        }
    }

    #[test]
    fn session_mode_ignores_typos_and_non_strings() {
        for v in serde_json::json!(["sharred", "share", "PERSISTENT", 1, true, null])
            .as_array()
            .unwrap()
        {
            let task = serde_json::json!({"context": {"session_mode": v}});
            assert!(
                !session_mode_is_shared(Some(&task)),
                "expected not-shared for {v}"
            );
        }
    }
}
