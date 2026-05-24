//! Claude Code CLI provider — wraps the Claude Code CLI subprocess.
//!
//! Spawns `claude -p` directly (no PTY, no shell wrapper), feeds the user
//! prompt on stdin, and tees the stream-json stdout into the task log file
//! for cost/token metrics. Returns a [`StepOutput`] with full telemetry.
//!
//! Registered as both `"claude-code"` (canonical) and `"anthropic"` (legacy alias).
//!
//! ## Why no `script(1)`/PTY?
//!
//! An earlier version wrapped `claude` in `script -q` to fake a TTY,
//! intending to force Node.js line-buffered output. In practice:
//!
//! * `--output-format stream-json` already emits one JSON object per line
//!   and flushes per event, so a PTY adds nothing.
//! * When orchestra runs under `nohup` / no controlling TTY (the common
//!   production case), `script` silently degrades — it logs
//!   `<not executed on terminal>`, the child claude exits ~2s later with
//!   no diagnostics on stdout/stderr, and the PTY log is empty.
//!
//! Spawning `claude` directly matches the working pattern used by
//! `starter-ai/runners/claude.rs` and avoids both issues.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tracing::{error, warn};

use super::{ProviderConfig, ResolvedStep, StepOutput, StepProvider, TaskContext};

/// Provider that executes steps via the Claude Code CLI.
pub struct ClaudeCodeProvider;

#[async_trait]
impl StepProvider for ClaudeCodeProvider {
    async fn execute(
        &self,
        step: &ResolvedStep,
        task: &TaskContext,
        _config: &ProviderConfig,
    ) -> anyhow::Result<StepOutput> {
        let worktree = task
            .working_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("ClaudeCodeProvider requires working_dir"))?;
        let log_file = task
            .log_file
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("ClaudeCodeProvider requires log_file"))?;

        let system_prompt = step.system_prompt.as_deref().unwrap_or("");
        let user_prompt = task.user_prompt.as_deref().unwrap_or(&task.project_context);

        run_claude(system_prompt, user_prompt, worktree, log_file, step).await?;
        let (cost, input_tokens, output_tokens, turns, stop, is_err, result_text) =
            parse_result_from_log(log_file).await;

        Ok(StepOutput {
            content: result_text,
            exit_code: if is_err { 1 } else { 0 },
            artifacts: HashMap::new(),
            cost_usd: cost,
            input_tokens,
            output_tokens,
            num_turns: turns,
            stop_reason: stop,
            is_error: is_err,
        })
    }

    fn name(&self) -> &'static str {
        "claude-code"
    }

    /// SoW-2 single-turn responder backend.
    ///
    /// Runs `claude -p --output-format text` with **no system prompt**,
    /// **no tools**, **no MCP**, and **no session persistence**. The
    /// working directory is a throwaway temp dir so the model has no
    /// filesystem context to confuse with the parked task's worktree.
    ///
    /// Returns the assistant's reply as plain text. Stderr is captured
    /// into the error message on non-zero exit so failures are
    /// diagnosable.
    async fn chat_once(&self, prompt: &str, config: &ProviderConfig) -> anyhow::Result<String> {
        let scratch =
            std::env::temp_dir().join(format!("diraigent-responder-{}", uuid::Uuid::now_v7()));
        tokio::fs::create_dir_all(&scratch)
            .await
            .context("create responder scratch dir")?;

        let mut args: Vec<String> = vec![
            "-p".into(),
            "--no-session-persistence".into(),
            "--output-format".into(),
            "text".into(),
        ];
        if let Some(m) = &config.model {
            args.push("--model".into());
            args.push(m.clone());
        }

        let mut child = Command::new("claude")
            .args(&args)
            .current_dir(&scratch)
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("spawn claude (chat_once)")?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .context("write prompt to claude stdin")?;
            stdin.shutdown().await.ok();
        }

        let output = child
            .wait_with_output()
            .await
            .context("wait for claude (chat_once)")?;

        // Best-effort cleanup.
        let _ = tokio::fs::remove_dir_all(&scratch).await;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(anyhow::anyhow!(
                "claude chat_once exited with {}: {}",
                output.status,
                stderr.trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

async fn run_claude(
    system_prompt: &str,
    user_prompt: &str,
    worktree: &Path,
    log_file: &Path,
    config: &ResolvedStep,
) -> anyhow::Result<()> {
    // Temp dir holds MCP config (if any). Prompts go directly on argv /
    // stdin, no shell quoting required.
    let temp_name = log_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("claude");
    let temp_dir = std::env::temp_dir().join(format!("claude-{temp_name}"));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .context("create temp dir")?;

    // Build argv. No shell, no quoting — every value is its own argv slot.
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--system-prompt".into(),
        system_prompt.to_string(),
        "--no-session-persistence".into(),
        "--dangerously-skip-permissions".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];

    if let Some(m) = &config.model {
        args.push("--model".into());
        args.push(m.clone());
    }
    if let Some(b) = config.budget {
        args.push("--max-budget-usd".into());
        args.push(format!("{b:.1}"));
    }
    for tool in &config.allowed_tools_list {
        args.push("--allowedTools".into());
        args.push(tool.clone());
    }
    if let Some(mcp) = &config.mcp_servers {
        let mcp_file = temp_dir.join("mcp_config.json");
        let mcp_json = serde_json::to_string_pretty(mcp).unwrap_or_default();
        tokio::fs::write(&mcp_file, &mcp_json)
            .await
            .context("write MCP config")?;
        args.push("--mcp-config".into());
        args.push(mcp_file.to_string_lossy().into_owned());
    }
    if let Some(agents) = &config.agents {
        args.push("--agents".into());
        args.push(serde_json::to_string(agents).unwrap_or_default());
    }
    if let Some(agent) = &config.agent {
        args.push("--agent".into());
        args.push(agent.clone());
    }
    if let Some(settings) = &config.settings {
        args.push("--settings".into());
        args.push(serde_json::to_string(settings).unwrap_or_default());
    }

    // Pre-create/truncate the log file so the parser sees an empty file
    // rather than ENOENT if claude exits before producing output.
    tokio::fs::write(log_file, b"").await.ok();

    let mut child = Command::new("claude")
        .args(&args)
        .current_dir(worktree)
        // CLAUDECODE is set by the parent claude session (when orchestra
        // itself was launched from inside claude); clearing it prevents
        // the child from inheriting/confusing the outer session.
        .env_remove("CLAUDECODE")
        .envs(config.env.iter())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawn claude process")?;

    // Feed the prompt on stdin and close it so claude knows input is done.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(user_prompt.as_bytes())
            .await
            .context("write prompt to claude stdin")?;
        stdin.shutdown().await.ok();
    }

    // Tee stdout to the log file, line by line. The downstream parser
    // only looks at the final `"type":"result"` line, so we just append.
    let stdout = child.stdout.take().context("claude stdout missing")?;
    let stderr = child.stderr.take().context("claude stderr missing")?;
    let log_path = log_file.to_path_buf();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut file = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                warn!("open claude log {}: {e}", log_path.display());
                return;
            }
        };
        while let Ok(Some(line)) = reader.next_line().await {
            if file.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = file.write_all(b"\n").await;
        }
        let _ = file.flush().await;
    });

    // Capture stderr to a sibling file so failures are diagnosable.
    let stderr_path = temp_dir.join("stderr.log");
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        let _ = tokio::fs::write(&stderr_path, buf).await;
    });

    let status = child.wait().await.context("wait for claude process")?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    // Clean up temp files (best-effort)
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    if !status.success() {
        error!("claude exited with status {status}");
        anyhow::bail!("claude exited with status {status}");
    }
    Ok(())
}

/// Parse the stream-json log file to extract cost, tokens, turns, result text, and error info.
///
/// Returns `(cost, input_tokens, output_tokens, turns, stop_reason, is_error, result_text)`.
pub(crate) async fn parse_result_from_log(
    log_file: &Path,
) -> (f64, u64, u64, u64, String, bool, String) {
    let content = match tokio::fs::read_to_string(log_file).await {
        Ok(c) => c,
        Err(e) => {
            warn!("could not read log file {}: {e}", log_file.display());
            return (0.0, 0, 0, 0, "unknown".into(), false, String::new());
        }
    };

    // Find last result line
    let result_line = content
        .lines()
        .rev()
        .find(|l| l.contains("\"type\":\"result\""));

    let Some(line) = result_line else {
        warn!("no result line found in log {}", log_file.display());
        return (0.0, 0, 0, 0, "unknown".into(), false, String::new());
    };

    // Try to parse the JSON (the line may have extra characters from script)
    let json_start = line.find('{');
    let Some(start) = json_start else {
        return (0.0, 0, 0, 0, "unknown".into(), false, String::new());
    };

    let json_str = &line[start..];
    let parsed: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return (0.0, 0, 0, 0, "unknown".into(), false, String::new()),
    };

    let cost = parsed["total_cost_usd"].as_f64().unwrap_or(0.0);
    let turns = parsed["num_turns"].as_u64().unwrap_or(0);
    let stop = parsed["stop_reason"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let is_error = parsed["is_error"].as_bool().unwrap_or(false);
    let result_text = parsed["result"].as_str().unwrap_or("").to_string();

    // Sum all input token variants (regular + cache creation + cache read).
    let usage = &parsed["usage"];
    let input_tokens = usage["input_tokens"].as_u64().unwrap_or(0)
        + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
        + usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    let output_tokens = usage["output_tokens"].as_u64().unwrap_or(0);

    (
        cost,
        input_tokens,
        output_tokens,
        turns,
        stop,
        is_error,
        result_text,
    )
}
