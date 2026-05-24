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
    /// SoW-8: when the agent finishes a step having burned most of
    /// its budget but produced zero diff lines and emitted no QA
    /// sentinel, synthesise a `gate_failure` QA item asking whether
    /// it is stuck. Default `true`; set `qa.stuck_detector: false` in
    /// a step's YAML to opt out (e.g. for steps whose work is
    /// intentionally non-diff producing like `verify`).
    pub stuck_detector: bool,
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
            stuck_detector: true,
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
    #[serde(default)]
    stuck_detector: Option<bool>,
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
    resolve_qa_config_with_override(step_name, step_json, None)
}

/// UI-gap #6: like [`resolve_qa_config`] but also accepts a per-task
/// override block (`task.context.qa_override` written by the advanced
/// UI). The override is field-wise merged onto the playbook `qa:`
/// block — any `Some` field in the override replaces the playbook's
/// value before validation and the safety policy runs. This means
/// override-supplied fields still go through the same schema check and
/// the same `Merge`-profile / irreversible upgrade pass, so a UI
/// override cannot bypass safety. An empty / null / missing override
/// is a no-op (behaves identically to the no-override path).
pub fn resolve_qa_config_with_override(
    step_name: &str,
    step_json: Option<&serde_json::Value>,
    task_qa_override: Option<&serde_json::Value>,
) -> Result<QaConfig, QaConfigError> {
    let mut raw = step_json.and_then(|s| s.get("qa")).cloned();

    if let Some(ovr) = task_qa_override
        && !ovr.is_null()
    {
        let Some(ovr_obj) = ovr.as_object() else {
            return Err(QaConfigError::Malformed(
                "context.qa_override must be an object".into(),
            ));
        };
        // Start from the playbook block (object, null, or missing) and
        // splat the override fields on top. Any non-object playbook
        // value is discarded — the override defines the new base.
        let mut merged = raw
            .as_ref()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        for (k, v) in ovr_obj {
            merged.insert(k.clone(), v.clone());
        }
        raw = Some(serde_json::Value::Object(merged));
    }

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
        stuck_detector: raw.stuck_detector.unwrap_or(true),
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

    #[test]
    fn stuck_detector_defaults_true() {
        let cfg = QaConfig::human_default();
        assert!(cfg.stuck_detector);

        let cfg = resolve_qa_config("implement", Some(&json!({"qa": {}}))).unwrap();
        assert!(cfg.stuck_detector);
    }

    #[test]
    fn stuck_detector_can_be_disabled() {
        let cfg = resolve_qa_config("implement", Some(&json!({"qa": {"stuck_detector": false}})))
            .unwrap();
        assert!(!cfg.stuck_detector);
    }

    // ── UI-gap #6: per-task qa_override merge ──────────────

    #[test]
    fn task_qa_override_replaces_playbook_field() {
        // Playbook says ai/confidence; task overrides accept to always_human.
        let step = json!({"qa": {"responder": "ai", "accept": "confidence"}});
        let ovr = json!({"accept": "always_human"});
        let cfg = resolve_qa_config_with_override("implement", Some(&step), Some(&ovr)).unwrap();
        assert_eq!(cfg.responder, Responder::Ai);
        assert_eq!(cfg.accept, AcceptMode::AlwaysHuman);
        assert!(!cfg.forced_second_pass);
    }

    #[test]
    fn task_qa_override_supplies_missing_playbook_block() {
        // Step has no qa block at all; override creates the whole policy.
        let ovr = json!({"responder": "ai", "accept": "always_ai"});
        let cfg = resolve_qa_config_with_override("implement", None, Some(&ovr)).unwrap();
        assert_eq!(cfg.responder, Responder::Ai);
        assert_eq!(cfg.accept, AcceptMode::AlwaysAi);
    }

    #[test]
    fn task_qa_override_still_runs_safety_upgrade() {
        // Override sets accept=confidence on the deliver step → must
        // get force-upgraded to second_pass like the playbook would.
        let ovr = json!({"responder": "ai", "accept": "confidence"});
        let cfg = resolve_qa_config_with_override("deliver", None, Some(&ovr)).unwrap();
        assert_eq!(cfg.accept, AcceptMode::SecondPass);
        assert!(cfg.forced_second_pass);
    }

    #[test]
    fn task_qa_override_validates_via_same_schema() {
        // Garbage accept value must fail with the same error as a
        // playbook-supplied garbage value would.
        let ovr = json!({"accept": "bogus"});
        let err = resolve_qa_config_with_override("implement", None, Some(&ovr)).unwrap_err();
        assert!(matches!(err, QaConfigError::BadAccept(_)), "got {err:?}");
    }

    #[test]
    fn task_qa_override_null_is_noop() {
        let step = json!({"qa": {"responder": "ai", "accept": "always_ai"}});
        let cfg =
            resolve_qa_config_with_override("implement", Some(&step), Some(&json!(null))).unwrap();
        assert_eq!(cfg.responder, Responder::Ai);
        assert_eq!(cfg.accept, AcceptMode::AlwaysAi);
    }

    #[test]
    fn task_qa_override_non_object_rejected() {
        let err =
            resolve_qa_config_with_override("implement", None, Some(&json!("nope"))).unwrap_err();
        assert!(matches!(err, QaConfigError::Malformed(_)), "got {err:?}");
    }

    #[test]
    fn task_qa_override_partial_merge_keeps_playbook_fields() {
        // Playbook: ai/confidence/min=0.9; override only bumps min.
        let step = json!({"qa": {"responder": "ai", "accept": "always_ai", "min_confidence": 0.9}});
        let ovr = json!({"min_confidence": 0.5});
        let cfg = resolve_qa_config_with_override("implement", Some(&step), Some(&ovr)).unwrap();
        assert_eq!(cfg.responder, Responder::Ai);
        assert_eq!(cfg.accept, AcceptMode::AlwaysAi);
        assert!((cfg.min_confidence - 0.5).abs() < 1e-6);
    }
}
