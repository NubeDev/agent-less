//! Task state machine rules shared between the API and orchestra.
//!
//! The API uses these for validation on human-initiated transitions.
//! The orchestra uses these as the authoritative state machine when
//! running in local orchestration mode.

/// Lifecycle states have fixed transition rules. Everything else is
/// a playbook step name (active execution state).
pub fn is_lifecycle_state(s: &str) -> bool {
    matches!(s, "backlog" | "ready" | "done" | "cancelled") || s.starts_with("wait:")
}

/// Returns true if the state is a `wait:<step>` inter-step state.
pub fn is_wait_state(s: &str) -> bool {
    s.starts_with("wait:")
}

/// Returns true if the state is a review state (`ai_review` or `human_review`).
///
/// Review states are an escape hatch from a running step: a step can transition
/// into a review state to park the task while a question is answered (by an AI
/// responder or a human). Resolving the review transitions the task back to a
/// named step (or escalates to the other review state, or cancels).
pub fn is_review_state(s: &str) -> bool {
    matches!(s, "ai_review" | "human_review")
}

/// Extract the next step name from a `wait:<step>` state.
pub fn wait_target(s: &str) -> Option<&str> {
    s.strip_prefix("wait:")
}

/// Validate whether a state transition is allowed.
///
/// ```text
///   backlog    → ready, cancelled
///   ready      → <step_name>, backlog, cancelled
///   <step>     → done, ready, cancelled, wait:<next>
///   wait:<s>   → <s> (via claim), cancelled
///   done       → backlog, human_review, ai_review
///   cancelled  → backlog
///   human_review → done, ready, backlog, cancelled, ai_review (escalate),
///                  any named step, or wait:<step> (resume after answer)
///   ai_review    → cancelled, human_review (escalate), any named step,
///                  or wait:<step> (resume after answer). Cannot go to
///                  done/ready/backlog directly — must resume or escalate.
/// ```
///
/// `wait:<step>` is permitted as a review-state target because the orchestra
/// poller only picks up tasks in `ready` or `wait:*`. Setting a bare step
/// name on resume leaves the task wedged with no claimer, so the API
/// translates the human-supplied step into `wait:<step>` before calling
/// `transition_task`. See `routes/qa.rs::answer`.
pub fn can_transition(current: &str, target: &str) -> bool {
    match current {
        "backlog" => matches!(target, "ready" | "cancelled"),
        "ready" => {
            // ready → any step name, or back to backlog/cancelled
            !is_lifecycle_state(target) || matches!(target, "backlog" | "cancelled")
        }
        "done" => {
            // done is terminal — reopen to backlog, move to human_review,
            // or roll back to ai_review when the worker detects unanswered
            // QA sentinels emitted after the agent ran `transition done`
            // (the orchestra's QA enforcement boundary overrides the
            // agent's premature completion claim).
            target == "backlog" || target == "human_review" || target == "ai_review"
        }
        "cancelled" => target == "backlog",
        _ if is_wait_state(current) => {
            // wait:<next> → the named step (via claim) or cancelled
            let next = wait_target(current).unwrap_or("");
            target == next || target == "cancelled"
        }
        "human_review" => {
            // Existing post-done review surface: approve (→done), rework
            // (→ready), reopen (→backlog), cancel, escalate (→ai_review),
            // or resume any named step with the answer (bare or via wait:).
            matches!(
                target,
                "done" | "ready" | "backlog" | "cancelled" | "ai_review"
            ) || is_wait_state(target)
                || (!is_lifecycle_state(target) && !is_review_state(target))
        }
        "ai_review" => {
            // AI review resolves via resume-to-step (bare or wait:<step>),
            // escalate to human, or cancel. Direct transitions to done/
            // ready/backlog are still forbidden — the answer must drive the
            // next step or escalation explicitly. wait:<step> is the path
            // the orchestra poller actually picks up.
            target == "cancelled"
                || target == "human_review"
                || is_wait_state(target)
                || (!is_lifecycle_state(target) && !is_review_state(target))
        }
        _ => {
            // Current state is a step name (e.g. implement, review).
            // Can go to done (final), wait:<next> (pipeline), ready (release),
            // a review state (park for QA), or cancelled.
            matches!(target, "done" | "ready" | "cancelled")
                || is_wait_state(target)
                || is_review_state(target)
        }
    }
}

/// Check if a playbook step is retriable (can be regressed to on rejection).
///
/// Reads `"retriable"` from the step JSON if present, otherwise falls back
/// to name-prefix classification (implement-like steps are retriable).
pub fn is_retriable_step(step: &serde_json::Value) -> bool {
    use crate::StepProfile;
    if let Some(v) = step.get("retriable").and_then(|v| v.as_bool()) {
        return v;
    }
    let name = step["name"].as_str().unwrap_or("");
    StepProfile::for_step(name).is_implement()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_states() {
        assert!(is_lifecycle_state("backlog"));
        assert!(is_lifecycle_state("ready"));
        assert!(is_lifecycle_state("done"));
        assert!(is_lifecycle_state("cancelled"));
        assert!(is_lifecycle_state("wait:review"));
        assert!(!is_lifecycle_state("implement"));
        assert!(!is_lifecycle_state("review"));
    }

    #[test]
    fn wait_states() {
        assert!(is_wait_state("wait:review"));
        assert!(!is_wait_state("ready"));
        assert_eq!(wait_target("wait:review"), Some("review"));
        assert_eq!(wait_target("ready"), None);
    }

    #[test]
    fn transitions() {
        // backlog
        assert!(can_transition("backlog", "ready"));
        assert!(can_transition("backlog", "cancelled"));
        assert!(!can_transition("backlog", "done"));

        // ready
        assert!(can_transition("ready", "implement"));
        assert!(can_transition("ready", "backlog"));
        assert!(!can_transition("ready", "done"));

        // step
        assert!(can_transition("implement", "done"));
        assert!(can_transition("implement", "ready"));
        assert!(can_transition("implement", "cancelled"));
        assert!(can_transition("implement", "wait:review"));
        assert!(!can_transition("implement", "backlog"));

        // wait
        assert!(can_transition("wait:review", "review"));
        assert!(can_transition("wait:review", "cancelled"));
        assert!(!can_transition("wait:review", "implement"));

        // done
        assert!(can_transition("done", "backlog"));
        assert!(can_transition("done", "human_review"));
        assert!(can_transition("done", "ai_review"));
        assert!(!can_transition("done", "ready"));

        // cancelled
        assert!(can_transition("cancelled", "backlog"));
        assert!(!can_transition("cancelled", "ready"));
    }

    #[test]
    fn review_state_predicate() {
        assert!(is_review_state("ai_review"));
        assert!(is_review_state("human_review"));
        assert!(!is_review_state("implement"));
        assert!(!is_review_state("done"));
        assert!(!is_review_state("ready"));
    }

    #[test]
    fn step_to_review_transitions() {
        // Any step can park into either review state.
        assert!(can_transition("implement", "ai_review"));
        assert!(can_transition("implement", "human_review"));
        assert!(can_transition("review", "ai_review"));
        assert!(can_transition("merge", "human_review"));
    }

    #[test]
    fn ai_review_transitions() {
        // Resume any named step (bare or via wait:<step>).
        assert!(can_transition("ai_review", "implement"));
        assert!(can_transition("ai_review", "review"));
        // wait:<step> is the form the orchestra poller picks up; the QA
        // answer route translates a human-supplied bare step to wait:.
        assert!(can_transition("ai_review", "wait:plan"));
        assert!(can_transition("ai_review", "wait:implement"));
        // Escalate to human.
        assert!(can_transition("ai_review", "human_review"));
        // Cancel.
        assert!(can_transition("ai_review", "cancelled"));
        // Forbidden: direct to terminal/queue states. Review only resolves
        // via resume-to-step or escalation.
        assert!(!can_transition("ai_review", "done"));
        assert!(!can_transition("ai_review", "ready"));
        assert!(!can_transition("ai_review", "backlog"));
    }

    #[test]
    fn human_review_transitions() {
        // Existing post-done behaviour preserved.
        assert!(can_transition("human_review", "done"));
        assert!(can_transition("human_review", "ready"));
        assert!(can_transition("human_review", "backlog"));
        assert!(can_transition("human_review", "cancelled"));
        // Resume any named step (e.g. after answering a QA item) — bare or
        // via wait:<step> for orchestra pickup.
        assert!(can_transition("human_review", "implement"));
        assert!(can_transition("human_review", "wait:review"));
        // Escalate to/from ai_review.
        assert!(can_transition("human_review", "ai_review"));
    }
}
