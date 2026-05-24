//! Handler for `playbook.request` WebSocket messages from the API.
//!
//! The API's `/v1/projects/{id}/playbooks` endpoints proxy through this
//! dispatcher so that the orchestra (which has on-disk access to each
//! project's repo) is the single source of truth for repo-sourced
//! playbooks under `.diraigent/playbooks/`.
//!
//! Supported operations (carried in the `operation` field):
//!   - `list`   → return all parsed playbooks (with provenance metadata)
//!   - `get`    → return a single playbook by `name`
//!   - `create` → write a new YAML file (`name` required, must not exist)
//!   - `update` → overwrite an existing YAML file
//!   - `delete` → remove a YAML file

use crate::project::api::ProjectsApi;
use crate::repo_playbooks::load_repo_playbooks;
use crate::ws::WsSender;
use crate::ws::protocol::WsMessage;
use std::path::{Path, PathBuf};
use tracing::{error, warn};
use uuid::Uuid;

pub struct PlaybookRequestParams {
    pub sender: WsSender,
    pub request_id: String,
    pub project_id: Uuid,
    pub operation: String,
    pub name: Option<String>,
    pub content: Option<serde_json::Value>,
    pub api: ProjectsApi,
    pub projects_path: PathBuf,
}

pub fn handle_playbook_request(params: PlaybookRequestParams) {
    let PlaybookRequestParams {
        sender,
        request_id,
        project_id,
        operation,
        name,
        content,
        api,
        projects_path: pp,
    } = params;

    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();

        // Resolve the project's git_root — that's where `.diraigent/playbooks/`
        // lives. For git_mode=none we fall back to the projects_path root.
        let repo_root = match rt.block_on(async {
            crate::project::paths::resolve_project_paths(&api, &project_id.to_string(), &pp).await
        }) {
            Ok(paths) => paths.git_root.unwrap_or(paths.working_dir),
            Err(e) => {
                warn!(
                    project_id = %project_id,
                    error = %e,
                    "failed to resolve project paths for playbook request; using projects_path"
                );
                pp.clone()
            }
        };

        let result = dispatch(&operation, &repo_root, name.as_deref(), content.as_ref());
        let (success, error, data) = match result {
            Ok(value) => (true, None, value),
            Err(e) => (false, Some(format!("{e:#}")), serde_json::Value::Null),
        };

        let response = WsMessage::PlaybookResponse {
            request_id,
            success,
            error,
            data,
        };
        if let Err(e) = sender.send(response) {
            error!("failed to send playbook response via WS: {e}");
        }
    });
}

fn dispatch(
    operation: &str,
    repo_root: &Path,
    name: Option<&str>,
    content: Option<&serde_json::Value>,
) -> anyhow::Result<serde_json::Value> {
    match operation {
        "list" => {
            let items = load_repo_playbooks(repo_root)?;
            Ok(serde_json::json!({ "items": items }))
        }
        "get" => {
            let name = name.ok_or_else(|| anyhow::anyhow!("`name` is required for get"))?;
            // Use load_repo_playbooks (not find_playbook_by_name) so the
            // returned playbook carries the source_path / source_url
            // provenance stamped by the loader.
            let items = load_repo_playbooks(repo_root)?;
            match items.into_iter().find(|p| p.name == name) {
                Some(pb) => Ok(serde_json::to_value(pb)?),
                None => Err(anyhow::anyhow!("playbook `{name}` not found")),
            }
        }
        "create" => {
            let name = name.ok_or_else(|| anyhow::anyhow!("`name` is required for create"))?;
            let body =
                content.ok_or_else(|| anyhow::anyhow!("`content` is required for create"))?;
            let path = playbook_path(repo_root, name)?;
            if path.exists() {
                return Err(anyhow::anyhow!("playbook `{name}` already exists"));
            }
            write_yaml(&path, body)?;
            Ok(serde_json::json!({ "name": name, "created": true }))
        }
        "update" => {
            let name = name.ok_or_else(|| anyhow::anyhow!("`name` is required for update"))?;
            let body =
                content.ok_or_else(|| anyhow::anyhow!("`content` is required for update"))?;
            let path = playbook_path(repo_root, name)?;
            if !path.exists() {
                return Err(anyhow::anyhow!("playbook `{name}` not found"));
            }
            write_yaml(&path, body)?;
            Ok(serde_json::json!({ "name": name, "updated": true }))
        }
        "delete" => {
            let name = name.ok_or_else(|| anyhow::anyhow!("`name` is required for delete"))?;
            let path = playbook_path(repo_root, name)?;
            if !path.exists() {
                return Err(anyhow::anyhow!("playbook `{name}` not found"));
            }
            std::fs::remove_file(&path)?;
            Ok(serde_json::json!({ "name": name, "deleted": true }))
        }
        other => Err(anyhow::anyhow!("unknown playbook operation `{other}`")),
    }
}

/// Build the on-disk path for a playbook, rejecting any `name` that contains
/// path separators or `..` segments to prevent escaping `.diraigent/playbooks/`.
fn playbook_path(repo_root: &Path, name: &str) -> anyhow::Result<PathBuf> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(anyhow::anyhow!("invalid playbook name `{name}`"));
    }
    Ok(repo_root
        .join(".diraigent")
        .join("playbooks")
        .join(format!("{name}.yaml")))
}

fn write_yaml(path: &Path, body: &serde_json::Value) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Round-trip JSON → YAML so the on-disk format matches what the
    // parser expects, regardless of what the caller sent.
    let yaml = serde_yaml::to_string(body)?;
    std::fs::write(path, yaml)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_in_name() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(playbook_path(tmp.path(), "../evil").is_err());
        assert!(playbook_path(tmp.path(), "foo/bar").is_err());
        assert!(playbook_path(tmp.path(), "").is_err());
        assert!(playbook_path(tmp.path(), ".hidden").is_err());
        assert!(playbook_path(tmp.path(), "standard").is_ok());
    }

    #[test]
    fn list_returns_empty_for_repo_without_playbooks() {
        let tmp = tempfile::tempdir().unwrap();
        let result = dispatch("list", tmp.path(), None, None).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn create_then_get_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let body = serde_json::json!({
            "title": "Test",
            "steps": [{ "name": "implement", "description": "do it" }]
        });
        dispatch("create", tmp.path(), Some("test"), Some(&body)).unwrap();

        let got = dispatch("get", tmp.path(), Some("test"), None).unwrap();
        assert_eq!(got["title"], "Test");
        assert_eq!(got["name"], "test");
    }

    #[test]
    fn create_rejects_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let body = serde_json::json!({
            "title": "T",
            "steps": [{ "name": "implement", "description": "x" }]
        });
        dispatch("create", tmp.path(), Some("dup"), Some(&body)).unwrap();
        let err = dispatch("create", tmp.path(), Some("dup"), Some(&body)).unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn update_requires_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let body = serde_json::json!({
            "title": "T",
            "steps": [{ "name": "implement", "description": "x" }]
        });
        let err = dispatch("update", tmp.path(), Some("nope"), Some(&body)).unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn delete_removes_file() {
        let tmp = tempfile::tempdir().unwrap();
        let body = serde_json::json!({
            "title": "T",
            "steps": [{ "name": "implement", "description": "x" }]
        });
        dispatch("create", tmp.path(), Some("toremove"), Some(&body)).unwrap();
        dispatch("delete", tmp.path(), Some("toremove"), None).unwrap();
        assert!(dispatch("get", tmp.path(), Some("toremove"), None).is_err());
    }

    #[test]
    fn unknown_operation_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let err = dispatch("frobnicate", tmp.path(), None, None).unwrap_err();
        assert!(err.to_string().contains("unknown playbook operation"));
    }
}
