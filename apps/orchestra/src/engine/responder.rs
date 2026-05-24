//! SoW-2: AI responder loop for QA items.
//!
//! Decoupled into:
//!
//! - Pure parsers ([`parse_responder_output`]) for the
//!   `<answer>...</answer> <confidence>0.NN</confidence>` envelope the
//!   responder produces.
//! - Pure accept-check ([`accept_check`]) that takes one or two
//!   [`ResponderAnswer`]s and decides Accept vs. Escalate per the
//!   configured [`AcceptMode`].
//! - A [`ResponderRunner`] trait so the worker integration tests can
//!   inject a deterministic fake without spinning up wiremock.
//! - An orchestrator ([`auto_answer_qa`]) that runs the responder once
//!   (or twice for `second_pass`) and returns the decision.
//!
//! The provider call itself is intentionally NOT in this module: the
//! existing `providers::StepProvider` infrastructure is reused at the
//! call site. This module just shapes the prompt and parses the result.

use crate::engine::qa_config::{AcceptMode, QaConfig};
use crate::providers::{ProviderConfig, StepProvider};
use anyhow::Result;
use async_trait::async_trait;
use std::sync::Arc;

/// Marker text the responder must surround its picked answer with.
const ANSWER_OPEN: &str = "<answer>";
const ANSWER_CLOSE: &str = "</answer>";
const CONFIDENCE_OPEN: &str = "<confidence>";
const CONFIDENCE_CLOSE: &str = "</confidence>";

/// One responder run's parsed output.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponderAnswer {
    /// The agent's chosen answer (free text or an option label).
    pub answer: String,
    /// Self-reported confidence in `[0.0, 1.0]`. `None` when the
    /// responder forgot the `<confidence>` block; treated as 0.0 by
    /// the confidence accept-check (i.e. always escalate).
    pub confidence: Option<f32>,
}

/// Outcome of an accept-check.
#[derive(Debug, Clone, PartialEq)]
pub enum AcceptDecision {
    /// The AI answer is trusted; resume the step with this answer.
    Accept { answer: String, rationale: String },
    /// The AI answer is not trusted; escalate to a human reviewer.
    Escalate { reason: String },
}

impl AcceptDecision {
    pub fn is_accept(&self) -> bool {
        matches!(self, Self::Accept { .. })
    }
}

/// Parse a single responder run's output text into a [`ResponderAnswer`].
///
/// Tolerant parser:
///
/// - `<answer>X</answer>` — the chosen answer. Required; if missing the
///   parser returns the trimmed whole text as the answer (so a chatty
///   responder still produces something the accept-check can compare).
/// - `<confidence>0.87</confidence>` — optional. Out-of-range or
///   un-parseable values yield `None`.
///
/// Whitespace inside the tags is stripped. Multiple `<answer>` blocks
/// in the same text keep only the first.
pub fn parse_responder_output(text: &str) -> ResponderAnswer {
    let answer = extract_tagged(text, ANSWER_OPEN, ANSWER_CLOSE)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| text.trim().to_string());
    let confidence = extract_tagged(text, CONFIDENCE_OPEN, CONFIDENCE_CLOSE)
        .and_then(|s| s.trim().parse::<f32>().ok())
        .filter(|v| (0.0..=1.0).contains(v));
    ResponderAnswer { answer, confidence }
}

fn extract_tagged(text: &str, open: &str, close: &str) -> Option<String> {
    let start = text.find(open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(close)?;
    Some(rest[..end].to_string())
}

/// Decide whether to accept the AI answer or escalate.
///
/// `primary` is always supplied. `secondary` is only consulted when
/// `mode == SecondPass`. For other modes it is ignored (callers may
/// pass `None`).
///
/// Acceptance rules:
///
/// - `Confidence`: accept iff `primary.confidence >= min_confidence`.
/// - `SecondPass`: accept iff `normalize(primary.answer) ==
///   normalize(secondary.answer)`. Confidence is ignored in this mode
///   — agreement is the signal.
/// - `AlwaysAi`: always accept the primary answer.
/// - `AlwaysHuman`: always escalate.
pub fn accept_check(
    mode: AcceptMode,
    min_confidence: f32,
    primary: &ResponderAnswer,
    secondary: Option<&ResponderAnswer>,
) -> AcceptDecision {
    match mode {
        AcceptMode::AlwaysHuman => AcceptDecision::Escalate {
            reason: "policy: always_human".into(),
        },
        AcceptMode::AlwaysAi => AcceptDecision::Accept {
            answer: primary.answer.clone(),
            rationale: "policy: always_ai".into(),
        },
        AcceptMode::Confidence => match primary.confidence {
            Some(c) if c >= min_confidence => AcceptDecision::Accept {
                answer: primary.answer.clone(),
                rationale: format!("confidence {c:.2} >= threshold {min_confidence:.2}"),
            },
            Some(c) => AcceptDecision::Escalate {
                reason: format!("confidence {c:.2} below threshold {min_confidence:.2}"),
            },
            None => AcceptDecision::Escalate {
                reason: "responder did not report <confidence>".into(),
            },
        },
        AcceptMode::SecondPass => {
            let Some(b) = secondary else {
                return AcceptDecision::Escalate {
                    reason: "second_pass requires a second responder run".into(),
                };
            };
            if normalize(&primary.answer) == normalize(&b.answer) {
                AcceptDecision::Accept {
                    answer: primary.answer.clone(),
                    rationale: "second_pass: both runs agreed".into(),
                }
            } else {
                AcceptDecision::Escalate {
                    reason: format!(
                        "second_pass: answers diverged ({:?} vs {:?})",
                        primary.answer, b.answer
                    ),
                }
            }
        }
    }
}

/// Case-insensitive whitespace-collapsed comparison for accept-check.
fn normalize(s: &str) -> String {
    s.split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Abstract responder. The production impl wraps the existing
/// `StepProvider` machinery; tests inject a deterministic fake.
///
/// The runner is called once per pass — `auto_answer_qa` loops itself
/// when `mode = SecondPass`. Implementations should vary something
/// between passes (temperature, model) to make agreement meaningful.
#[async_trait]
pub trait ResponderRunner: Send + Sync {
    async fn run(&self, pass: u8, prompt: &str) -> Result<String>;
}

/// Production [`ResponderRunner`] that bridges to the existing
/// [`StepProvider`] machinery via `StepProvider::chat_once`.
///
/// Only providers that override the default `chat_once` (currently:
/// `claude-code`) will work here — the others return a clear error.
///
/// The runner injects no system prompt and no tools: the prompt
/// produced by [`build_responder_prompt`] is the whole context the
/// model sees. Both passes use the same provider/config — the pure
/// orchestrator in [`auto_answer_qa`] still calls run twice for
/// `SecondPass`, and we rely on natural model nondeterminism for
/// disagreement to surface.
pub struct ProviderResponderRunner {
    provider: Arc<dyn StepProvider>,
    config: ProviderConfig,
}

impl ProviderResponderRunner {
    pub fn new(provider: Arc<dyn StepProvider>, config: ProviderConfig) -> Self {
        Self { provider, config }
    }
}

#[async_trait]
impl ResponderRunner for ProviderResponderRunner {
    async fn run(&self, _pass: u8, prompt: &str) -> Result<String> {
        self.provider.chat_once(prompt, &self.config).await
    }
}

/// Build the responder prompt that gets fed to the LLM.
///
/// Kept small and stable so the second-pass run can reasonably be
/// expected to converge on the same answer for the same input.
pub fn build_responder_prompt(question: &str, options: Option<&[String]>) -> String {
    let mut p = String::new();
    p.push_str("You are answering a question on behalf of an autonomous coding agent.\n");
    p.push_str("Respond with EXACTLY this format:\n\n");
    p.push_str("<answer>your chosen answer</answer>\n");
    p.push_str("<confidence>0.NN</confidence>\n\n");
    p.push_str("Where confidence is between 0.0 and 1.0 reflecting how sure you are.\n");
    if let Some(opts) = options
        && !opts.is_empty()
    {
        p.push_str("Pick exactly one of these options for the <answer>:\n");
        for o in opts {
            p.push_str("- ");
            p.push_str(o);
            p.push('\n');
        }
        p.push('\n');
    }
    p.push_str("Question:\n");
    p.push_str(question);
    p.push('\n');
    p
}

/// Run the responder once or twice (per mode) and apply the accept-check.
///
/// Pure orchestration — does NOT touch the API. Worker integration is
/// in `engine/worker.rs`; the responder there persists the decision
/// (qa answer + transition) only if we return `Accept`.
pub async fn auto_answer_qa(
    runner: &dyn ResponderRunner,
    cfg: &QaConfig,
    question: &str,
    options: Option<&[String]>,
) -> Result<AcceptDecision> {
    let prompt = build_responder_prompt(question, options);

    // AlwaysHuman short-circuits — no LLM call at all.
    if cfg.accept == AcceptMode::AlwaysHuman {
        return Ok(AcceptDecision::Escalate {
            reason: "policy: always_human".into(),
        });
    }

    let raw1 = runner.run(1, &prompt).await?;
    let a1 = parse_responder_output(&raw1);

    let a2 = if cfg.accept == AcceptMode::SecondPass {
        let raw2 = runner.run(2, &prompt).await?;
        Some(parse_responder_output(&raw2))
    } else {
        None
    };

    Ok(accept_check(
        cfg.accept,
        cfg.min_confidence,
        &a1,
        a2.as_ref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::qa_config::{Irreversible, QaConfig, Responder};
    use std::sync::Mutex;

    fn cfg(accept: AcceptMode, min_confidence: f32) -> QaConfig {
        QaConfig {
            responder: Responder::Ai,
            accept,
            min_confidence,
            on_irreversible: Irreversible::Ai,
            expires_at_secs: 300,
            forced_second_pass: false,
            stuck_detector: true,
        }
    }

    // ── parse_responder_output ──────────────────────────────

    #[test]
    fn parses_well_formed_envelope() {
        let r =
            parse_responder_output("<answer>postgres</answer>\n<confidence>0.92</confidence>\n");
        assert_eq!(r.answer, "postgres");
        assert_eq!(r.confidence, Some(0.92));
    }

    #[test]
    fn falls_back_when_answer_tag_missing() {
        let r = parse_responder_output("  just text  ");
        assert_eq!(r.answer, "just text");
        assert_eq!(r.confidence, None);
    }

    #[test]
    fn rejects_out_of_range_confidence() {
        let r = parse_responder_output("<answer>x</answer><confidence>1.5</confidence>");
        assert_eq!(r.confidence, None);
    }

    #[test]
    fn picks_first_answer_block() {
        let r = parse_responder_output("<answer>first</answer><answer>second</answer>");
        assert_eq!(r.answer, "first");
    }

    // ── accept_check ────────────────────────────────────────

    #[test]
    fn always_human_always_escalates() {
        let a = ResponderAnswer {
            answer: "y".into(),
            confidence: Some(1.0),
        };
        let d = accept_check(AcceptMode::AlwaysHuman, 0.85, &a, None);
        assert!(matches!(d, AcceptDecision::Escalate { .. }));
    }

    #[test]
    fn always_ai_always_accepts() {
        let a = ResponderAnswer {
            answer: "y".into(),
            confidence: None,
        };
        let d = accept_check(AcceptMode::AlwaysAi, 0.85, &a, None);
        assert!(d.is_accept());
    }

    #[test]
    fn confidence_above_threshold_accepts() {
        let a = ResponderAnswer {
            answer: "y".into(),
            confidence: Some(0.9),
        };
        let d = accept_check(AcceptMode::Confidence, 0.85, &a, None);
        assert!(d.is_accept());
    }

    #[test]
    fn confidence_below_threshold_escalates() {
        let a = ResponderAnswer {
            answer: "y".into(),
            confidence: Some(0.5),
        };
        let d = accept_check(AcceptMode::Confidence, 0.85, &a, None);
        match d {
            AcceptDecision::Escalate { reason } => assert!(reason.contains("below threshold")),
            _ => panic!("expected escalate"),
        }
    }

    #[test]
    fn confidence_missing_escalates() {
        let a = ResponderAnswer {
            answer: "y".into(),
            confidence: None,
        };
        let d = accept_check(AcceptMode::Confidence, 0.85, &a, None);
        assert!(matches!(d, AcceptDecision::Escalate { .. }));
    }

    #[test]
    fn second_pass_agreement_accepts() {
        let a = ResponderAnswer {
            answer: "Postgres".into(),
            confidence: Some(0.4),
        };
        let b = ResponderAnswer {
            answer: "postgres".into(), // case differs, normalize matches
            confidence: Some(0.4),
        };
        let d = accept_check(AcceptMode::SecondPass, 0.85, &a, Some(&b));
        assert!(d.is_accept(), "case-insensitive agreement should accept");
    }

    #[test]
    fn second_pass_disagreement_escalates() {
        let a = ResponderAnswer {
            answer: "postgres".into(),
            confidence: Some(0.9),
        };
        let b = ResponderAnswer {
            answer: "sqlite".into(),
            confidence: Some(0.9),
        };
        let d = accept_check(AcceptMode::SecondPass, 0.85, &a, Some(&b));
        assert!(matches!(d, AcceptDecision::Escalate { .. }));
    }

    #[test]
    fn second_pass_without_second_run_escalates() {
        let a = ResponderAnswer {
            answer: "x".into(),
            confidence: None,
        };
        let d = accept_check(AcceptMode::SecondPass, 0.85, &a, None);
        assert!(matches!(d, AcceptDecision::Escalate { .. }));
    }

    // ── auto_answer_qa orchestration ────────────────────────

    /// Deterministic fake: returns canned responses per-pass.
    struct FakeRunner {
        responses: Mutex<Vec<String>>,
    }

    impl FakeRunner {
        fn new(responses: Vec<&'static str>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().map(String::from).collect()),
            }
        }
    }

    #[async_trait]
    impl ResponderRunner for FakeRunner {
        async fn run(&self, _pass: u8, _prompt: &str) -> Result<String> {
            let mut q = self.responses.lock().unwrap();
            Ok(q.remove(0))
        }
    }

    #[tokio::test]
    async fn auto_answer_always_human_short_circuits_no_call() {
        let runner = FakeRunner::new(vec![]); // would panic on call
        let d = auto_answer_qa(&runner, &cfg(AcceptMode::AlwaysHuman, 0.85), "q", None)
            .await
            .unwrap();
        assert!(matches!(d, AcceptDecision::Escalate { .. }));
    }

    #[tokio::test]
    async fn auto_answer_confidence_happy_path() {
        let runner = FakeRunner::new(vec![
            "<answer>postgres</answer><confidence>0.9</confidence>",
        ]);
        let d = auto_answer_qa(&runner, &cfg(AcceptMode::Confidence, 0.85), "db?", None)
            .await
            .unwrap();
        match d {
            AcceptDecision::Accept { answer, .. } => assert_eq!(answer, "postgres"),
            _ => panic!("expected accept"),
        }
    }

    #[tokio::test]
    async fn auto_answer_second_pass_runs_twice() {
        let runner = FakeRunner::new(vec![
            "<answer>postgres</answer><confidence>0.4</confidence>",
            "<answer>POSTGRES</answer><confidence>0.4</confidence>",
        ]);
        let d = auto_answer_qa(&runner, &cfg(AcceptMode::SecondPass, 0.85), "db?", None)
            .await
            .unwrap();
        assert!(d.is_accept());
    }

    #[test]
    fn build_prompt_includes_options() {
        let p = build_responder_prompt("db?", Some(&["pg".into(), "sqlite".into()]));
        assert!(p.contains("- pg"));
        assert!(p.contains("- sqlite"));
        assert!(p.contains("Question:"));
        assert!(p.contains("db?"));
    }
}
