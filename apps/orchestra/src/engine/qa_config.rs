//! SoW-2: per-step QA policy parsed from the playbook step JSON.
//!
//! A step may declare a `qa:` block telling the orchestra how to answer
//! questions the agent asks via the SoW-1 sentinel:
//!
//! ```yaml
//! - name: implement
//!   qa:
//!     responder: ai            # ai | human (default: human)
//!     accept: confidence       # confidence | second_pass | always_human | always_ai
//!     min_confidence: 0.85     # required when accept = confidence
//!     on_irreversible: human   # human | ai — defaults to human
//!     expires_at_secs: 300     # AI answer timeout, escalates to human after
//! ```
//!
//! Defaults policy (intentionally cautious so existing playbooks are unchanged):
//!
//! - No `qa:` block at all → `responder = human`, no auto-answer attempted.
//! - `StepProfile::Merge` OR `on_irreversible: human` → force
//!   `accept: second_pass` even if YAML asked for `confidence`. The
//!   `forced_second_pass` flag on the returned config records this so
//!   callers can log the upgrade.

use diraigent_types::StepProfile;
use serde::{Deserialize, Serialize};

/// How a returned answer is accepted (or escalated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptMode {
    /// Accept iff the responder reports `<confidence>0.NN</confidence>` >= threshold.
    Confidence,
    /// Two responder runs with different temperatures must agree.
    SecondPass,
    /// Never auto-accept; always escalate to a human.
    AlwaysHuman,
    /// Always accept the AI answer (use sparingly — basically opt-out of accept-check).
    AlwaysAi,
}

/// Who answers the QA: the AI responder or a human reviewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Responder {
    Ai,
    Human,
}

/// Behaviour when the question is judged irreversible (e.g. on a merge step).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Irreversible {
    Human,
    Ai,
}

/// Resolved per-step QA policy after schema validation and defaults policy.
#[derive(Debug, Clone, PartialEq)]
pub struct QaConfig {
    pub responder: Responder,
    pub accept: AcceptMode,
    pub min_confidence: f32,
    pub on_irreversible: Irreversible,
    pub expires_at_secs: u32,
    /// True when the runtime upgraded `accept` from `confidence` to
    /// `second_pass` because the step is a merge / irreversible step.
    /// The worker logs this so playbook authors can see when their
    /// declared accept mode is being overridden for safety.
    pub forced_second_pass: bool,
}

impl QaConfig {
    /// Default for steps that omit a `qa:` block entirely. Safe rollout:
    /// behaves like the pre-SoW-2 world — every QA goes to a human.
    pub fn human_default() -> Self {
        Self {
            responder: Responder::Human,
            accept: AcceptMode::AlwaysHuman,
            min_confidence: DEFAULT_MIN_CONFIDENCE,
            on_irreversible: Irreversible::Human,
            expires_at_secs: DEFAULT_AI_EXPIRES_SECS,
            forced_second_pass: false,
        }
    }
}

/// Default confidence threshold when YAML omits `min_confidence`.
pub const DEFAULT_MIN_CONFIDENCE: f32 = 0.85;
/// Default expiry window for an AI-targeted QA.
pub const DEFAULT_AI_EXPIRES_SECS: u32 = 300;

/// Raw YAML shape — exists only to drive serde validation. Callers should
/// not consume this directly; use [`resolve_qa_config`] which folds the
/// defaults policy and returns a [`QaConfig`].
#[derive(Debug, Deserialize)]
struct RawQa {
    #[serde(default)]
    responder: Option<String>,
    #[serde(default)]
    accept: Option<String>,
    #[serde(default)]
    min_confidence: Option<f32>,
    #[serde(default)]
    on_irreversible: Option<String>,
    #[serde(default)]
    expires_at_secs: Option<u32>,
}

/// Error produced when a step's `qa:` block fails schema validation.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum QaConfigError {
    #[error("qa.responder must be one of ai|human, got {0:?}")]
    BadResponder(String),
    #[error("qa.accept must be one of confidence|second_pass|always_human|always_ai, got {0:?}")]
    BadAccept(String),
    #[error("qa.min_confidence must be in [0.0, 1.0], got {0}")]
    BadMinConfidence(f32),
    #[error("qa.on_irreversible must be one of human|ai, got {0:?}")]
    BadOnIrreversible(String),
    #[error("qa block is malformed: {0}")]
    Malformed(String),
}

/// Resolve the QA policy for a step.
///
/// `step_json` is the playbook step JSON (the JSONB blob the API stores
/// per-step). When `step_json["qa"]` is absent or null, returns
/// [`QaConfig::human_default`] — no auto-answer is attempted.
///
/// When present, the block is validated against the schema and folded
/// with the safety policy:
///
/// 1. If the step is a `StepProfile::Merge` step, force
///    `accept = SecondPass` (sets `forced_second_pass = true`).
/// 2. Else if `on_irreversible = human` *and* the declared accept is
///    `Confidence`, force `accept = SecondPass`. This protects against
///    a single-pass confidence answer on an irreversible action.
pub fn resolve_qa_config(
    step_name: &str,
    step_json: Option<&serde_json::Value>,
) -> Result<QaConfig, QaConfigError> {
    let raw = step_json.and_then(|s| s.get("qa")).cloned();
    let Some(raw) = raw else {
        return Ok(QaConfig::human_default());
    };
    if raw.is_null() {
        return Ok(QaConfig::human_default());
    }
    let raw: RawQa =
        serde_json::from_value(raw).map_err(|e| QaConfigError::Malformed(e.to_string()))?;

    let responder = match raw.responder.as_deref() {
        None | Some("human") => Responder::Human,
        Some("ai") => Responder::Ai,
        Some(other) => return Err(QaConfigError::BadResponder(other.to_string())),
    };

    let mut accept = match raw.accept.as_deref() {
        None => {
            // No accept specified: human → AlwaysHuman; ai → Confidence
            // (which is itself promoted to SecondPass on merge steps).
            match responder {
                Responder::Human => AcceptMode::AlwaysHuman,
                Responder::Ai => AcceptMode::Confidence,
            }
        }
        Some("confidence") => AcceptMode::Confidence,
        Some("second_pass") => AcceptMode::SecondPass,
        Some("always_human") => AcceptMode::AlwaysHuman,
        Some("always_ai") => AcceptMode::AlwaysAi,
        Some(other) => return Err(QaConfigError::BadAccept(other.to_string())),
    };

    let min_confidence = raw.min_confidence.unwrap_or(DEFAULT_MIN_CONFIDENCE);
    if !(0.0..=1.0).contains(&min_confidence) {
        return Err(QaConfigError::BadMinConfidence(min_confidence));
    }

    let on_irreversible = match raw.on_irreversible.as_deref() {
        None | Some("human") => Irreversible::Human,
        Some("ai") => Irreversible::Ai,
        Some(other) => return Err(QaConfigError::BadOnIrreversible(other.to_string())),
    };

    let expires_at_secs = raw.expires_at_secs.unwrap_or(DEFAULT_AI_EXPIRES_SECS);

    // Defaults policy: upgrade Confidence → SecondPass on irreversible work.
    let is_merge = StepProfile::for_step(step_name) == StepProfile::Merge;
    let force_second_pass =
        (is_merge || on_irreversible == Irreversible::Human) && accept == AcceptMode::Confidence;
    if force_second_pass {
        accept = AcceptMode::SecondPass;
    }

    Ok(QaConfig {
        responder,
        accept,
        min_confidence,
        on_irreversible,
        expires_at_secs,
        forced_second_pass: force_second_pass,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_qa_block_yields_human_default() {
        let cfg = resolve_qa_config("implement", None).unwrap();
        assert_eq!(cfg, QaConfig::human_default());

        let cfg = resolve_qa_config("implement", Some(&json!({"name": "implement"}))).unwrap();
        assert_eq!(cfg, QaConfig::human_default());

        let cfg = resolve_qa_config("implement", Some(&json!({"qa": null}))).unwrap();
        assert_eq!(cfg, QaConfig::human_default());
    }

    #[test]
    fn ai_responder_defaults_to_confidence_then_safety_upgraded() {
        // responder=ai with no `on_irreversible` defaults to `human`, which
        // upgrades `confidence` → `second_pass`. To get a raw Confidence
        // accept, the playbook author must explicitly opt out via
        // `on_irreversible: ai`.
        let cfg =
            resolve_qa_config("implement", Some(&json!({"qa": {"responder": "ai"}}))).unwrap();
        assert_eq!(cfg.responder, Responder::Ai);
        assert_eq!(cfg.accept, AcceptMode::SecondPass);
        assert!(cfg.forced_second_pass);
        assert_eq!(cfg.min_confidence, DEFAULT_MIN_CONFIDENCE);
    }

    #[test]
    fn merge_step_forces_second_pass() {
        let cfg = resolve_qa_config(
            "merge",
            Some(&json!({"qa": {"responder": "ai", "accept": "confidence"}})),
        )
        .unwrap();
        assert_eq!(cfg.accept, AcceptMode::SecondPass);
        assert!(cfg.forced_second_pass);
    }

    #[test]
    fn deliver_step_also_treated_as_merge() {
        let cfg = resolve_qa_config(
            "deliver",
            Some(&json!({"qa": {"responder": "ai", "accept": "confidence"}})),
        )
        .unwrap();
        assert_eq!(cfg.accept, AcceptMode::SecondPass);
        assert!(cfg.forced_second_pass);
    }

    #[test]
    fn on_irreversible_human_upgrades_confidence() {
        let cfg = resolve_qa_config(
            "implement",
            Some(&json!({"qa": {
                "responder": "ai",
                "accept": "confidence",
                "on_irreversible": "human"
            }})),
        )
        .unwrap();
        assert_eq!(cfg.accept, AcceptMode::SecondPass);
        assert!(cfg.forced_second_pass);
    }

    #[test]
    fn on_irreversible_ai_does_not_upgrade() {
        let cfg = resolve_qa_config(
            "implement",
            Some(&json!({"qa": {
                "responder": "ai",
                "accept": "confidence",
                "on_irreversible": "ai"
            }})),
        )
        .unwrap();
        assert_eq!(cfg.accept, AcceptMode::Confidence);
        assert!(!cfg.forced_second_pass);
    }

    #[test]
    fn always_human_is_not_upgraded() {
        let cfg = resolve_qa_config(
            "merge",
            Some(&json!({"qa": {"responder": "ai", "accept": "always_human"}})),
        )
        .unwrap();
        assert_eq!(cfg.accept, AcceptMode::AlwaysHuman);
        assert!(!cfg.forced_second_pass);
    }

    #[test]
    fn rejects_invalid_responder() {
        let err = resolve_qa_config("implement", Some(&json!({"qa": {"responder": "alien"}})))
            .unwrap_err();
        assert_eq!(err, QaConfigError::BadResponder("alien".into()));
    }

    #[test]
    fn rejects_invalid_accept() {
        let err = resolve_qa_config(
            "implement",
            Some(&json!({"qa": {"responder": "ai", "accept": "shrug"}})),
        )
        .unwrap_err();
        assert_eq!(err, QaConfigError::BadAccept("shrug".into()));
    }

    #[test]
    fn rejects_out_of_range_min_confidence() {
        let err = resolve_qa_config(
            "implement",
            Some(&json!({"qa": {"responder": "ai", "min_confidence": 1.5}})),
        )
        .unwrap_err();
        assert!(matches!(err, QaConfigError::BadMinConfidence(_)));
    }

    #[test]
    fn rejects_invalid_on_irreversible() {
        let err = resolve_qa_config(
            "implement",
            Some(&json!({"qa": {"responder": "ai", "on_irreversible": "maybe"}})),
        )
        .unwrap_err();
        assert_eq!(err, QaConfigError::BadOnIrreversible("maybe".into()));
    }

    #[test]
    fn explicit_human_responder_keeps_always_human() {
        let cfg =
            resolve_qa_config("implement", Some(&json!({"qa": {"responder": "human"}}))).unwrap();
        assert_eq!(cfg.responder, Responder::Human);
        assert_eq!(cfg.accept, AcceptMode::AlwaysHuman);
    }

    #[test]
    fn expires_at_secs_default_and_override() {
        let cfg =
            resolve_qa_config("implement", Some(&json!({"qa": {"responder": "ai"}}))).unwrap();
        assert_eq!(cfg.expires_at_secs, DEFAULT_AI_EXPIRES_SECS);

        let cfg = resolve_qa_config(
            "implement",
            Some(&json!({"qa": {"responder": "ai", "expires_at_secs": 60}})),
        )
        .unwrap();
        assert_eq!(cfg.expires_at_secs, 60);
    }
}
