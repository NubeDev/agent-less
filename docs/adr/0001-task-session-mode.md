# ADR 0001 — `task.context.session_mode`

- **Status**: Proposed (2026-05-24)
- **Closes**: [UI-UPDATES.md](../../UI-UPDATES.md) gap #6 — final outstanding field is `session_mode`
- **Scope**: orchestra runtime, Claude Code provider, task schema

## Context

The advanced-task form already serializes
[`task.context.session_mode`](../../apps/web/src/app/features/advanced/advanced-new.ts#L574)
with values `"per_step"` (default) and `"shared"`. A checkbox
([advanced-new.ts:223](../../apps/web/src/app/features/advanced/advanced-new.ts#L223))
toggles between them and the UI displays a warning when `"shared"` is
selected:

> ⚠ Shared session is experimental. Providers without session reuse
> will silently fall back to per_step.

That promise sets the bar for runtime support: any provider that lacks
session reuse must keep working — `"shared"` simply becomes a no-op
there.

Today the orchestra ignores the field entirely.
[claude_code.rs:171](../../apps/orchestra/src/providers/claude_code.rs#L171)
hardcodes `--no-session-persistence` on every spawn, which (per
`claude --help`) "[disables] session persistence — sessions will not
be saved to disk and cannot be resumed". Every step of every task is
therefore a fresh conversation with no memory of the prior step.

This ADR designs the smallest change that delivers the UI's promise.

## Decision

### 1. Two-tier semantics

`session_mode = "per_step"` (default):
- Behaviour identical to today. Each step spawn passes
  `--no-session-persistence`.
- Step boundaries are conversation boundaries. Context flows only
  through the existing `PreviousStepContext` plumbing
  ([providers/mod.rs:82](../../apps/orchestra/src/providers/mod.rs#L82)).

`session_mode = "shared"`:
- The task gets a stable `session_id` (UUID) generated at first spawn
  and reused for every subsequent step within that task run.
- The Claude Code provider drops `--no-session-persistence` and adds:
  - first spawn: `--session-id <uuid>` (forces Claude to adopt our id)
  - subsequent spawns: `--resume <uuid>` (loads the prior conversation)
- QA re-runs (worker.rs:1277) follow the same rule — a re-run of a
  step in `"shared"` mode resumes the session, so the re-invoked
  responder sees what the prior attempt said.
- Cancelled / merged / cleaned-up tasks: the session id is **not**
  garbage-collected; Claude's session store handles its own lifecycle.
  We only own the pointer.
- Other providers (`anthropic`, `openai`, `copilot`, `ollama`,
  `sentinel`): no-op. They log once at info level when they receive
  `session_mode = "shared"` so the UI's "silent fallback" promise is
  observable in logs, then continue exactly as today.

### 2. Where the session_id lives

**Add a `session_id text` column to `diraigent.task`** (new migration
`051_task_session_id.sql`). Rationale:

- Survives orchestra restarts. A worker crash mid-task must not lose
  the session pointer; replaying the next step on a different
  orchestra instance must resume the same Claude session.
- Cheap to query — every spawn already does `api.get_task(task_id)`.
- Distinct from `context` JSONB because it is runtime state, not user
  intent. `context.session_mode` is the *policy*; `session_id` is the
  *handle*. Mixing them invites bugs where a UI re-save clobbers an
  in-flight session.

Column is nullable. NULL on a task means "no session yet" — first
spawn of a `"shared"`-mode task allocates one with `Uuid::new_v4()`
and PATCHes the task before invoking Claude.

### 3. Provider trait change

Extend `TaskContext`
([providers/mod.rs:82](../../apps/orchestra/src/providers/mod.rs#L82))
with one field:

```rust
pub struct TaskContext {
    // … existing fields …
    /// Session reuse policy + handle. `None` means per_step.
    /// `Some(SessionHandle { id, is_first_spawn })` means shared.
    pub session: Option<SessionHandle>,
}

pub struct SessionHandle {
    pub id: Uuid,
    pub is_first_spawn: bool,
}
```

Adding to `TaskContext` (rather than a new trait method) keeps the
provider trait API stable — existing providers that don't care simply
ignore the field. Only Claude Code's `run_claude`
([claude_code.rs:171](../../apps/orchestra/src/providers/claude_code.rs#L171))
branches on it.

### 4. Allocation point

Allocation happens in the **spawner**
([apps/orchestra/src/engine/spawner.rs](../../apps/orchestra/src/engine/spawner.rs)),
not the provider, because:

- The spawner already fetches `task` for `task_overrides_from_context`
  (model, budget). One more JSONB read costs nothing.
- The spawner already calls `api.update_task` for telemetry hooks —
  PATCHing `session_id` follows the same path.
- The provider stays stateless w.r.t. the task row; it only sees the
  resolved `SessionHandle`.

Algorithm:

```text
fn build_session_handle(task) -> Option<SessionHandle>:
  if context.session_mode != "shared": return None
  if task.session_id is set: return Some({id: task.session_id, is_first_spawn: false})
  new_id = Uuid::new_v4()
  api.update_task(task_id, {session_id: new_id})  # persist BEFORE spawn
  return Some({id: new_id, is_first_spawn: true})
```

Persisting before the spawn means a crashed-spawn replay sees the id
and resumes (correct), not allocates a new one (wrong — would orphan
the first session).

### 5. Claude Code wiring

In `run_claude`
([claude_code.rs:171](../../apps/orchestra/src/providers/claude_code.rs#L171)):

```rust
match &task.session {
    None => {
        args.push("--no-session-persistence".into());
    }
    Some(s) if s.is_first_spawn => {
        args.push("--session-id".into());
        args.push(s.id.to_string());
    }
    Some(s) => {
        args.push("--resume".into());
        args.push(s.id.to_string());
    }
}
```

Same change at [claude_code.rs:100](../../apps/orchestra/src/providers/claude_code.rs#L100)
(`chat_once`, the responder backend). Open question: should the
responder share the main step session, or get its own? **Answer**:
its own. The responder is a meta-conversation about answering a QA
sentinel; mixing it into the main session would pollute the
implementation conversation with QA reasoning. Defer: add a second
nullable column `responder_session_id` only if/when we want responder
session reuse across QA rounds. Not in this ADR's scope.

### 6. Cross-cutting interactions

Each of these was raised in the prior handover as a risk; resolution
follows.

**Worktree reuse.** Worktrees already survive across pipeline steps
within a task ([project/paths.rs](../../apps/orchestra/src/project/paths.rs)).
Session reuse aligns: the conversation lives in the same working
directory, which is what Claude expects when resuming. No change.

**Budget rollup.** Costs are posted per-spawn additively
([worker.rs:1004-1013](../../apps/orchestra/src/engine/worker.rs#L1004-L1013)).
Session reuse doesn't change the math — Claude bills per request
regardless of session continuity. Prompt-cache hit rates may *improve*
under `"shared"` (same conversation prefix), which is a side benefit,
not a correctness concern.

**QA resumption.** Today's re-run re-invokes the same spawn path
([worker.rs:1277](../../apps/orchestra/src/engine/worker.rs#L1277)).
With `"shared"` mode, the re-run resumes the prior session — the
re-invoked step sees the question and answer in the conversation and
can react. With `"per_step"`, behaviour is unchanged. Worth noting:
under `"shared"` mode, the existing `qa_answer` injected into
`PreviousStepContext` becomes partially redundant (the answer is also
in the conversation history). Keep both — the structured field is
machine-readable, the conversation history is for reasoning continuity.
No-op for providers that don't support sessions.

**Provider migration after first spawn.** If a task's `model` /
`provider` override changes between steps and the new provider doesn't
support sessions, we log and silently fall back to per_step for that
step only. The `session_id` column stays populated; if a later step
swings back to Claude, it resumes the same session.

## Implementation slices

Mechanical work after this ADR is approved. Suggested order:

1. **Migration** — `051_task_session_id.sql` adds the column.
   `Task` model field, `update_task` shape extension.
   (~30 LoC + index on `(session_id) WHERE session_id IS NOT NULL`.)

2. **Spawner allocation** — `build_session_handle` helper +
   unit tests over the 3 paths (per_step / shared+first / shared+resume).
   Persists to API before returning.

3. **Provider plumbing** — `TaskContext` field + `SessionHandle`
   struct + threading through every `provider.execute` call site
   (worker.rs spawn path, responder path).

4. **Claude Code branching** — replace the two hardcoded
   `--no-session-persistence` lines with the match block above.
   Other providers stay byte-identical.

5. **Provider no-op logging** — once-per-task `info!` in non-Claude
   providers when they see `task.session.is_some()`, so the UI's
   "silent fallback" is observable. Use a `tracing` span field, not a
   sentinel log line, to keep production logs tidy.

6. **Tests**
   - spawner unit: allocates UUID on first shared spawn, reuses on
     second, never allocates on per_step.
   - integration smoke (existing test rig under
     [apps/orchestra/tests/](../../apps/orchestra/tests/)): two-step
     playbook in shared mode, assert the same session_id used twice.
   - Claude CLI invocation: assert `--session-id` on first spawn,
     `--resume` on second, neither on per_step.

7. **Docs** — update [SCOPE.md](../../SCOPE.md) "Known gaps" entry +
   close UI-UPDATES.md gap #6 entirely.

Estimated total: ~250 LoC, three commits (migration+model+spawner / 
provider plumbing+claude / tests+docs).

## Out of scope

- **Cross-task session reuse.** Sessions are task-scoped. Threading
  one session across multiple tasks is a different feature (closer to
  a long-lived agent persona) and not what this UI field promises.
- **Responder session reuse.** Justified above — track separately if
  ever needed.
- **GC of orphaned Claude session files.** Claude Code owns its own
  on-disk session store. We never call `claude --remove-session` or
  similar. If users want cleanup, that's a Claude CLI / shell
  housekeeping concern.
- **Session export / inspection from the UI.** Out of scope; the
  session is a runtime detail, not a user artifact. If exposed later,
  it would belong under the advanced-detail page, not the new-task
  form.
- **Other providers gaining session support.** OpenAI's Responses API
  has a `previous_response_id` concept that could map onto this, but
  it's a separate provider integration. Land Claude support first;
  generalize only when a second concrete provider needs it.

## Alternatives considered

**A. Store session_id in `context` JSONB.** Rejected: mixes user
intent with runtime state. A UI re-save would clobber the live
session pointer.

**B. Per-step session_id (allow shared across some steps, per-step
across others).** Rejected: no UI surface for it, and the user-facing
mental model is "this task is one conversation" — splitting it would
be confusing. The existing `context.steps[].model` per-step override
is the precedent — but model is provider config, session_id is
conversational continuity. Keep it task-scoped.

**C. Drop `session_mode` from the UI entirely.** Rejected: the UI is
shipped and the field is set on real tasks. Silently honoring it is
strictly better than asking the form to be redesigned.

**D. Use Claude's `--continue` flag (continue most recent
conversation in the working directory).** Rejected: brittle. Multiple
concurrent tasks share the same git root for different worktrees;
"most recent" is racy under concurrent orchestra workers. Explicit
session IDs are the only safe option.

## References

- Claude CLI `--help`: confirms `--session-id <uuid>`, `-r/--resume
  [value]`, `-c/--continue`, `--no-session-persistence` exist.
  Verified locally on 2026-05-24.
- [UI-UPDATES.md](../../UI-UPDATES.md) §6.
- [sessions/2026-05-24-handover.md](../../sessions/2026-05-24-handover.md)
  — risk list for the three remaining gap-#6 fields.
