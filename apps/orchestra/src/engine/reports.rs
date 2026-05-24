//! Auto-report generators invoked from `StepOutcome::AllDone`.
//!
//! Each public function builds a `(title, markdown_body, metadata)` tuple
//! from data already available at the scheduler call-site or fetched
//! through the `TaskSource` trait. The scheduler then POSTs the result
//! via `api.post_auto_report`.
//!
//! Generators are intentionally pure-ish (only side effect is the API
//! fetch where unavoidable) so they can be unit-tested over fixtures
//! without spinning up a worker.

use crate::git::ChangedFile;
use serde_json::{Value, json};

pub struct GeneratedReport {
    pub title: String,
    pub body: String,
    pub metadata: Value,
}

/// Recognised report kinds. Anything else is a no-op so a UI rollout
/// of new kinds doesn't crash older orchestra binaries.
pub fn is_known_kind(kind: &str) -> bool {
    matches!(
        kind,
        "diff_summary" | "cost_breakdown" | "qa_log" | "handover_chain" | "knowledge_touched"
    )
}

/// `diff_summary` — totals + per-file list of what changed.
pub fn diff_summary(
    changed_files: &[ChangedFile],
    insertions: usize,
    deletions: usize,
) -> GeneratedReport {
    let mut body = String::new();
    body.push_str(&format!(
        "**{} files changed, +{insertions} −{deletions}**\n\n",
        changed_files.len()
    ));
    if changed_files.is_empty() {
        body.push_str("_No files changed._");
    } else {
        for f in changed_files {
            body.push_str(&format!("- `{}` ({})\n", f.path, f.change_type));
        }
    }

    GeneratedReport {
        title: "Diff summary".to_string(),
        body,
        metadata: json!({
            "files_changed": changed_files.len(),
            "insertions": insertions,
            "deletions": deletions,
        }),
    }
}

/// `cost_breakdown` — total task cost plus per-step breakdown if the
/// task carries `context.steps[*].cost_usd` entries (populated by the
/// per-step cost rollup landed in SoW-2). Falls back to total-only.
pub fn cost_breakdown(task: &Value) -> GeneratedReport {
    let total = task.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);

    let mut body = format!("**Total: ${total:.4}**\n\n");

    let steps = task
        .get("context")
        .and_then(|c| c.get("steps"))
        .and_then(|s| s.as_array());

    if let Some(steps) = steps {
        let mut any = false;
        for step in steps {
            let name = step
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("(unnamed)");
            if let Some(cost) = step.get("cost_usd").and_then(|c| c.as_f64()) {
                if !any {
                    body.push_str("| Step | Cost |\n|---|---:|\n");
                    any = true;
                }
                body.push_str(&format!("| {name} | ${cost:.4} |\n"));
            }
        }
        if !any {
            body.push_str("_No per-step cost data on task._");
        }
    } else {
        body.push_str("_No per-step cost data on task._");
    }

    GeneratedReport {
        title: "Cost breakdown".to_string(),
        body,
        metadata: json!({ "total_cost_usd": total }),
    }
}

/// `qa_log` — markdown rollup of resolved QA items for the task.
pub fn qa_log(qa_items: &[Value]) -> GeneratedReport {
    let mut body = format!("**{} resolved QA items**\n\n", qa_items.len());
    if qa_items.is_empty() {
        body.push_str("_No QA sentinels fired._");
    } else {
        for item in qa_items {
            let step = item
                .get("step_name")
                .and_then(|s| s.as_str())
                .unwrap_or("?");
            let kind = item.get("kind").and_then(|k| k.as_str()).unwrap_or("qa");
            let q = item
                .get("question")
                .and_then(|q| q.as_str())
                .unwrap_or("(no question)");
            let a = item
                .get("answer")
                .and_then(|a| a.as_str())
                .unwrap_or("(no answer)");
            body.push_str(&format!(
                "### [{step}] {kind}\n\n**Q:** {q}\n\n**A:** {a}\n\n---\n\n"
            ));
        }
    }

    GeneratedReport {
        title: "QA log".to_string(),
        body,
        metadata: json!({ "qa_count": qa_items.len() }),
    }
}

/// `handover_chain` — collect task updates with `kind == "handover"`.
pub fn handover_chain(task_updates: &[Value]) -> GeneratedReport {
    let handovers: Vec<&Value> = task_updates
        .iter()
        .filter(|u| u.get("kind").and_then(|k| k.as_str()) == Some("handover"))
        .collect();

    let mut body = format!("**{} handover(s)**\n\n", handovers.len());
    if handovers.is_empty() {
        body.push_str("_No handovers recorded._");
    } else {
        for h in &handovers {
            let content = h
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("(empty handover)");
            let created = h.get("created_at").and_then(|t| t.as_str()).unwrap_or("?");
            body.push_str(&format!("### {created}\n\n{content}\n\n---\n\n"));
        }
    }

    GeneratedReport {
        title: "Handover chain".to_string(),
        body,
        metadata: json!({ "handover_count": handovers.len() }),
    }
}

/// `knowledge_touched` — list related knowledge / decisions /
/// observations from `GET /v1/tasks/{id}/related`.
pub fn knowledge_touched(related: &Value) -> GeneratedReport {
    let knowledge = related
        .get("knowledge")
        .and_then(|k| k.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let decisions = related
        .get("decisions")
        .and_then(|d| d.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let observations = related
        .get("observations")
        .and_then(|o| o.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);

    let mut body = String::new();
    body.push_str(&format!("## Knowledge ({})\n\n", knowledge.len()));
    if knowledge.is_empty() {
        body.push_str("_None._\n\n");
    } else {
        for k in knowledge {
            let title = k
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("(untitled)");
            body.push_str(&format!("- {title}\n"));
        }
        body.push('\n');
    }

    body.push_str(&format!("## Decisions ({})\n\n", decisions.len()));
    if decisions.is_empty() {
        body.push_str("_None._\n\n");
    } else {
        for d in decisions {
            let title = d
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("(untitled)");
            body.push_str(&format!("- {title}\n"));
        }
        body.push('\n');
    }

    body.push_str(&format!("## Observations ({})\n\n", observations.len()));
    if observations.is_empty() {
        body.push_str("_None._\n");
    } else {
        for o in observations {
            let title = o
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("(untitled)");
            body.push_str(&format!("- {title}\n"));
        }
    }

    GeneratedReport {
        title: "Knowledge touched".to_string(),
        body,
        metadata: json!({
            "knowledge_count": knowledge.len(),
            "decisions_count": decisions.len(),
            "observations_count": observations.len(),
        }),
    }
}

/// Parse `task.context.reports` — accept an array of strings; ignore
/// anything else (including absence). Unknown kinds are silently
/// dropped so a UI ahead of orchestra doesn't blow up tasks.
pub fn requested_kinds(task: &Value) -> Vec<String> {
    task.get("context")
        .and_then(|c| c.get("reports"))
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| is_known_kind(s))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cf(path: &str, kind: &str) -> ChangedFile {
        ChangedFile {
            path: path.to_string(),
            change_type: kind.to_string(),
            diff: None,
        }
    }

    #[test]
    fn diff_summary_empty() {
        let r = diff_summary(&[], 0, 0);
        assert_eq!(r.title, "Diff summary");
        assert!(r.body.contains("0 files changed"));
        assert!(r.body.contains("No files changed"));
        assert_eq!(r.metadata["files_changed"], 0);
    }

    #[test]
    fn diff_summary_with_files() {
        let files = vec![cf("src/a.rs", "M"), cf("src/b.rs", "A")];
        let r = diff_summary(&files, 12, 3);
        assert!(r.body.contains("2 files changed, +12 −3"));
        assert!(r.body.contains("`src/a.rs` (M)"));
        assert!(r.body.contains("`src/b.rs` (A)"));
        assert_eq!(r.metadata["insertions"], 12);
        assert_eq!(r.metadata["deletions"], 3);
    }

    #[test]
    fn cost_breakdown_with_steps() {
        let task = json!({
            "cost_usd": 1.2345,
            "context": {
                "steps": [
                    {"name": "implement", "cost_usd": 1.0},
                    {"name": "review", "cost_usd": 0.2345},
                ]
            }
        });
        let r = cost_breakdown(&task);
        assert!(r.body.contains("Total: $1.2345"));
        assert!(r.body.contains("| implement | $1.0000 |"));
        assert!(r.body.contains("| review | $0.2345 |"));
    }

    #[test]
    fn cost_breakdown_no_step_data() {
        let task = json!({"cost_usd": 0.5});
        let r = cost_breakdown(&task);
        assert!(r.body.contains("Total: $0.5000"));
        assert!(r.body.contains("No per-step cost data"));
    }

    #[test]
    fn qa_log_empty() {
        let r = qa_log(&[]);
        assert!(r.body.contains("0 resolved QA items"));
        assert!(r.body.contains("No QA sentinels"));
    }

    #[test]
    fn qa_log_formats_items() {
        let items = vec![json!({
            "step_name": "review",
            "kind": "question",
            "question": "Is X correct?",
            "answer": "Yes."
        })];
        let r = qa_log(&items);
        assert!(r.body.contains("[review] question"));
        assert!(r.body.contains("**Q:** Is X correct?"));
        assert!(r.body.contains("**A:** Yes."));
        assert_eq!(r.metadata["qa_count"], 1);
    }

    #[test]
    fn handover_chain_filters_kind() {
        let updates = vec![
            json!({"kind": "progress", "content": "ignore me"}),
            json!({"kind": "handover", "content": "ctx for next step", "created_at": "2026-05-24T10:00:00Z"}),
        ];
        let r = handover_chain(&updates);
        assert!(r.body.contains("1 handover"));
        assert!(r.body.contains("ctx for next step"));
        assert!(!r.body.contains("ignore me"));
        assert_eq!(r.metadata["handover_count"], 1);
    }

    #[test]
    fn knowledge_touched_counts_each_bucket() {
        let related = json!({
            "knowledge": [{"title": "K1"}],
            "decisions": [{"title": "D1"}, {"title": "D2"}],
            "observations": []
        });
        let r = knowledge_touched(&related);
        assert!(r.body.contains("Knowledge (1)"));
        assert!(r.body.contains("Decisions (2)"));
        assert!(r.body.contains("Observations (0)"));
        assert!(r.body.contains("- K1"));
        assert_eq!(r.metadata["decisions_count"], 2);
        assert_eq!(r.metadata["observations_count"], 0);
    }

    #[test]
    fn requested_kinds_filters_unknown() {
        let task = json!({"context": {"reports": ["diff_summary", "bogus", "qa_log"]}});
        assert_eq!(
            requested_kinds(&task),
            vec!["diff_summary".to_string(), "qa_log".to_string()]
        );
    }

    #[test]
    fn requested_kinds_missing_field() {
        assert!(requested_kinds(&json!({})).is_empty());
        assert!(requested_kinds(&json!({"context": {}})).is_empty());
        assert!(requested_kinds(&json!({"context": {"reports": "not-array"}})).is_empty());
    }
}
