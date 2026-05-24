# Diraigent update spec: AI-first QA responder loop + structured handover

**Status:** draft for implementation (peer-reviewed; corrections folded in 2026-05-24)
**Scope:** add an AI-responder stage in front of human review so a stuck step
is answered by an AI first and only escalates to a human when the AI answer
isn't trusted; in the same plumbing, add structured cross-step handover.

---

## 0. Why this doc exists

Diraigent already implements most of the "outside the loop" machinery
(playbooks, knowledge, decisions, observations, multi-provider, git worktrees,
state machine, review queue). This spec does **not** rebuild any of that. It
adds the missing piece: a structured **question/answer (QA) item** that can be
answered by an **AI responder first**, with the **human as fallback**, feeding
the answer back so the agent resumes — plus a structured **handover** between
steps that rides the same parser.

> Grounded in the repo source (`main`, read 2026-05-24). Specific files/symbols
> are cited so you can verify before editing. Anything marked **VERIFY** is an
> assumption to confirm against current code before implementing.

---

## 1. What already exists (do not rebuild)

Confirmed from source:

- **State machine** — [libs/common-rust/diraigent-types/src/state_machine.rs](libs/common-rust/diraigent-types/src/state_machine.rs).
  Lifecycle states are `backlog | ready | done | cancelled | wait:<step>`; any
  other state string is treated as a playbook step name. `can_transition()` is
  the single authority. `done → human_review` is already legal; the catch-all
  branch lets a step transition to `done | ready | cancelled | wait:<next>`
  but **not** to another named step — that gap matters for §3.2 below.
- **Step profiles / cascade** — [step_profile.rs](libs/common-rust/diraigent-types/src/step_profile.rs).
  `StepProfile` enum (Review / Merge / Dream / Implement), classified by step-
  name prefix. Per-step config (`model`, `budget`, `allowed_tools`) lives in
  the playbook step JSON.
- **Playbooks as YAML in git** — migration `046_playbook_yaml_source_of_truth.sql`
  dropped the DB table; playbooks now live in `.diraigent/playbooks/*.yaml`.
  Each step is parsed into a `serde_json::Value` in
  [repo_playbooks.rs](apps/orchestra/src/repo_playbooks.rs) — **so adding new
  per-step fields (e.g. `qa:`) needs no schema migration**.
- **Providers** — [apps/orchestra/src/providers/](apps/orchestra/src/providers/)
  (`claude_code`, `copilot`, `anthropic`, `openai`, `ollama`). Spawning an
  agent is solved; an "AI responder" is just another provider call.
- **Worker loop** — [engine/worker.rs](apps/orchestra/src/engine/worker.rs) +
  [engine/pipeline.rs](apps/orchestra/src/engine/pipeline.rs). On
  failure/provider error the worker posts a `blocker` task-update (around
  `worker.rs:560` and `worker.rs:665`). Agents can also post observations.
- **Knowledge / decisions / observations** — both orchestra-side
  (`apps/orchestra/src/repo_*.rs`) and API-side
  (`apps/api/src/repository/{knowledge,decisions,observations}.rs`). Cross-run
  memory already exists.
- **Review queue (human)** — surfaced via `done → human_review` plus the web UI.
- **SSE** — `apps/api/src/routes/sse.rs` exists; **VERIFY** whether it
  broadcasts new `task_updates` rows in a shape the Angular review-queue
  client already subscribes to. This is a prerequisite check before SoW-1.

### What does **not** exist (corrects an earlier draft of this doc)

- **No mid-stream control channel to the agent.** [providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs)
  spawns `claude -p`, pipes the entire prompt, closes stdin, and waits for exit.
  We parse the agent's output **after exit**, from the per-task log file the
  provider already reads to build its final result.
- **No streaming stdout parser in `worker.rs`.** `log_monitor.rs` is a Loki
  *poller* (not a stdout pipeline) and is unrelated. Any sentinel parser is
  new code attached to the post-exit log read.
- **No structured "needs input" signal in any provider today.** That is the
  gap this spec fills.

---

## 2. The change in one paragraph

When a step needs a decision (the agent asks a question, or hits a blocker that
is *answerable* rather than fatal), it emits a sentinel block in its output.
**After the step exits**, the worker parses the log for the sentinel; if
found, it creates a structured **QA item** and transitions the task into a
new `ai_review` state. An **AI responder** (a cheap, scoped, read-only
provider call) answers; an **accept-check** decides whether to trust the
answer. If yes, the original step is **re-run from scratch** in the same
worktree with the answer injected; if no, the QA item escalates to the
existing **human_review** path. The same parser also extracts a structured
`HANDOVER` block at end of step, persisted and injected into the next step's
prompt, so cross-step continuity stops relying on the next agent re-reading
the worktree to figure out what just happened.

---

## 3. Scope of work — ranked

Ship in this order. Each tier is independently valuable.

### SoW-0: Doc fixes (LANDED)

- README.md state-machine diagram (`human_review → backlog` was wrong;
  real targets are `done | ready | cancelled | wait:<next>`).
- NEW-TASK.md state-machine diagram (`draft`/`in_progress`/`blocked` don't
  exist; rewritten to match `state_machine.rs`).
- NEW-TASK.md "ready from draft" → "ready from backlog".

### SoW-1 (Tier 1, game-changer): QA-item sentinel loop, human-only responder

Detect "agent needs a decision" reliably, surface it as a structured QA item,
route to a human. No AI responder yet — humans answer 100% in this slice.

**Acceptance criteria:**

1. New migration `047_task_qa_item.sql` creating a dedicated table with
   columns: `id`, `task_id`, `step_name`, `kind` (`question | blocker |
   gate_failure`), `prompt`, `options jsonb?`, `responder` (`ai | human`),
   `answer text?`, `answered_by text?`, `status` (`pending | answered |
   accepted | escalated | resolved`), `expires_at`, `created_at`,
   `answered_at`, `resolved_at`, plus tenant/project scoping consistent with
   sibling tables.
2. Sentinel parser, attached to the existing post-exit log read in
   [providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs):
   - Format: line beginning at column 0 reading
     `DIRAIGENT_QA[<nonce>]: <question>` (optional preceding
     `DIRAIGENT_QA_OPTIONS[<nonce>]: a|b|c`), closed by a line beginning at
     column 0 reading `DIRAIGENT_QA_END[<nonce>]`.
   - The `<nonce>` is minted per step and embedded in the step's system
     prompt; sentinels without the live nonce are ignored. Defeats
     stored-prompt-injection via issue bodies, READMEs, or MCP tool output.
3. **Agent-ignored-stop guard.** The agent cannot actually be paused
   mid-stream (see §1 corrections). If a sentinel is detected in the log,
   the step is treated as `ai_review` **regardless of exit code, diff
   presence, or "success" signals from the provider.** An agent that asks a
   question, guesses, and commits a diff must not merge.
4. State-machine update in
   [state_machine.rs](libs/common-rust/diraigent-types/src/state_machine.rs):
   - New predicate `is_review_state(s) -> bool` returning true for
     `ai_review` and `human_review`.
   - Catch-all step arm permits `target ∈ {done, ready, cancelled,
     wait:<next>}` **plus** any `is_review_state(target)`.
   - New arm: `if is_review_state(current)` permits transitions to any
     non-lifecycle state (back to a named step) or to the other review state
     (escalation), or to `cancelled`.
   - Tests added alongside existing `state_machine.rs:95` test block.
5. Pipeline update: symmetric `AiReview` arm in
   [engine/pipeline.rs](apps/orchestra/src/engine/pipeline.rs) next to the
   existing `HumanReview` arm; orchestra does nothing while task is in
   `ai_review` (parked, worker freed for other ticks).
6. API update: `apps/api/src/routes/tasks.rs` accepts the new transitions
   (`tasks.rs:516` area needs amending; not just `state_machine.rs`).
7. Bridge row: every QA item insert also writes a `task_updates` row of kind
   `question` (already in the enum per `001_schema.sql:343-352`) with
   `metadata.qa_item_id` pointing at the new row. Preserves the existing
   thread/UI for free.
8. SSE: the existing channel broadcasts the bridge row. **VERIFY before
   coding** — if it doesn't, add the broadcast as part of this SoW.
9. New routes `apps/api/src/routes/qa.rs`: list pending QA items, submit a
   human answer (validates via `state_machine::can_transition` and writes
   `qa_item.status = resolved`, then transitions `human_review → <step>`).
10. System-prompt addendum (in `engine/prompt.rs`) instructing the agent how
    and when to emit the sentinel block, including the per-step nonce.
11. End-to-end test: a step that emits a forged sentinel without the nonce
    is **not** treated as a QA. A step that emits the correct sentinel
    *and then keeps writing files and exits 0* is still routed to QA, not
    merged.

### SoW-2 (Tier 1, game-changer): AI responder + accept-check + auto-resume

Now the QA item is answered by an AI first; the original step re-runs in the
same worktree with the answer injected. Humans only see escalations.

**Acceptance criteria:**

1. AI responder = a `readonly`-profile provider call (reuses existing
   tool-preset gate). **Must not** have write, shell, git, or MCP tools.
2. New `PreviousStepContext` struct (defined in SoW-3, see below) is the
   carrier for the QA answer back into the resumed step.
3. Re-run semantics: full re-invocation of the same step in the same
   worktree (worktree reuse already works per
   [git/worktree.rs:60](apps/orchestra/src/git/worktree.rs)). **No attempt
   to "continue" a provider session** — none exists.
4. **Budget rollup must not reset on re-run.** A task that burns `$X` on
   the first attempt and `$Y` on the re-run is billed `$X + $Y`. Add a
   regression test around the cost accounting in `worker.rs:640` area.
5. Per-step `qa:` config in playbook YAML, riding the existing
   `serde_json::Value` step schema:
   ```yaml
   qa:
     responder: ai            # ai | human   (default: ai)
     accept: confidence       # confidence | second_pass | always_human | always_ai
     min_confidence: 0.85     # validated 0.0..=1.0 on playbook load
     on_irreversible: human   # forces human for the step's QA, regardless of `accept`
   ```
6. **Defaults policy:**
   - Default `accept`: `confidence` with `min_confidence: 0.85`.
   - **Forced `second_pass` (not opt-in)** for any step whose profile is
     `StepProfile::Merge`, and for any step where `on_irreversible: human`
     is set. The doubled cost on irreversible/merge work is non-negotiable.
   - `always_human` is the implicit default if no `qa:` block is given on a
     step (safe rollout — every existing playbook keeps current behaviour).
7. Accept-check modes:
   - `confidence`: AI returns answer + self-reported `confidence ∈ [0,1]`;
     accept iff `confidence >= min_confidence`. Doc the known
     miscalibration caveat in the playbook schema.
   - `second_pass`: run two independent responder calls with different
     temperatures (and ideally different models if configured); accept iff
     both produce semantically equivalent answers (start with exact-string
     equality on `options`-style answers; for free-text, an LLM-judge call
     is acceptable v1).
   - `always_human`: skip responder, go straight to `human_review`.
   - `always_ai`: accept first answer regardless (use only for low-risk
     steps like `dream`).
8. Timeouts:
   - QA item has `expires_at`. AI QA defaults to a short window (5 min);
     on expiry, escalate to `human_review` with status `escalated`,
     reason `ai_timeout`.
   - **Human QA does not auto-cancel on expiry.** It just keeps waiting.
     (Auto-cancel of a task is a separate, task-level deadline feature, not
     this SoW.) Optional per-playbook notification escalation is a follow-up.
9. `on_irreversible: human` is a Tier-1 must-ship knob, not optional.
10. End-to-end test: a step raises a QA, AI answers with confidence 0.9,
    step re-runs and merges; total cost = first run + responder + re-run.
11. End-to-end test: a `Merge`-profile step with `accept: confidence`
    declared in YAML is silently upgraded to `second_pass` at runtime.

### SoW-3 (Tier 2, quick win): Structured handover between steps

Stop relying on the next agent re-deriving context from the worktree. Define
the carrier struct used by both this SoW and SoW-2.

**Acceptance criteria:**

1. New struct `PreviousStepContext { from_step: String, handover:
   Option<String>, qa_answer: Option<String> }` in
   `apps/orchestra/src/engine/`. Replaces the bare `Option<String>` field
   `ProviderTaskContext.previous_step_output` at all three current call
   sites (`worker.rs:629`, `mod.rs:227`, `chat.rs:650`), which currently
   pass `None` and have no consumer.
2. Same sentinel parser extended to extract a `HANDOVER[<nonce>]: ...
   HANDOVER_END[<nonce>]` block at end-of-step.
3. Persisted as a `task_updates` row of new kind `handover` — requires a
   migration to add the variant to the kind enum (cheap, isolated).
4. Consumer side: [engine/prompt.rs](apps/orchestra/src/engine/prompt.rs)
   gains a renderer that, when `PreviousStepContext` has a handover or
   qa_answer, prepends a `## Handover from <from_step>` section to the
   next step's prompt.
5. System-prompt addendum (all steps) instructing the agent to end its
   turn with the `HANDOVER` block, summarising decisions made, anything
   deferred, and anything the next step needs to know.
6. Estimate: ~1 day (producer + consumer + migration + tests). The parser
   is a freebie on top of SoW-1; the rest is not.

### SoW-4 (Tier 2, quick win): QA-decision telemetry

Make the loop learn.

**Acceptance criteria:**

1. Add `outcome` column to `task_qa_item`:
   `resolved_clean | resolved_reverted | resolved_followup | unknown`.
2. Backfill from existing task-revert events and observation links where
   possible; default to `unknown`.
3. Updated by a background job (or inline trigger) when the task that
   resolved the QA is later reverted or spawns a follow-up observation.
4. No UI yet — purpose is to enable later tuning of `min_confidence` and
   `confidence` vs `second_pass` comparison.

### SoW-8 (Tier 2, promoted): Stuck-detector watchdog

Catches the failure mode where the agent doesn't know it's stuck. Cheap
because it runs in the same post-exit path as the sentinel parser.

**Acceptance criteria:**

1. In the post-exit handler, compute: `budget_burned_fraction` and
   `diff_line_delta`. If `budget_burned_fraction >= 0.8` AND
   `diff_line_delta == 0`, synthesise a QA item of kind `gate_failure`
   with prompt "Step burned <X>% of budget without producing a diff —
   are you stuck? If so, what do you need?" and route through the
   normal QA pipeline.
2. Per-step opt-out via `qa.stuck_detector: false` (default true).
3. Counts as a QA, so respects the step's `responder` / `accept` config.

### Tier 3 (defer)

- **SoW-6: MCP `ask` tool.** Replaces the sentinel with a structured
  protocol. Real cost: orchestra becomes an MCP host (a new process or
  in-process server), JSON-RPC plumbing, and a streaming round-trip back
  into the running step. Not a like-for-like swap for grep. Defer until
  sentinel proves the loop in production.
- **SoW-7: N-of-M responder fan-out.** Run K different models on the
  same QA, accept on majority. Strictly stronger than `second_pass` but
  multiplies QA cost by K. Defer until telemetry (SoW-4) shows the
  baseline error rate is too high.

---

## 4. Sentinel design (the load-bearing piece)

This is detected **post-exit**, by reading the per-task log file that
[providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs:55)
already reads to construct its final result. There is no mid-stream
intervention — the agent runs to completion (or budget exhaustion) whether
or not it emits the sentinel.

**Format (column 0 of a fresh line, nonce-bracketed):**

```
DIRAIGENT_QA[7f3a]: Should I use Postgres or SQLite for the cache?
DIRAIGENT_QA_OPTIONS[7f3a]: postgres|sqlite|skip
DIRAIGENT_QA_END[7f3a]
```

```
HANDOVER[7f3a]: Implemented greet() in src/lib.rs; deferred internationalisation
to a follow-up; no schema changes; tests pass under cargo test --lib.
HANDOVER_END[7f3a]
```

The `<nonce>` is minted by the worker per step, included in the step's system
prompt, and required by the parser. This blocks the realistic injection vector
(agent reads attacker-controlled content containing a forged sentinel and
echoes it).

QA text rendered in the UI must be treated as **plaintext** (no HTML, no
auto-link rendering). Standard hygiene — verify in the Angular surface.

---

## 5. State-machine changes (concrete)

In [state_machine.rs](libs/common-rust/diraigent-types/src/state_machine.rs):

```rust
pub fn is_review_state(s: &str) -> bool {
    matches!(s, "ai_review" | "human_review")
}
```

Amend `can_transition`:

- Step arm (catch-all): permit `target` if it is `done | ready | cancelled |
  wait:<next>` **or** `is_review_state(target)`.
- New arm before catch-all: `_ if is_review_state(current) =>
  is_review_state(target) || (!is_lifecycle_state(target)) || target ==
  "cancelled"` — i.e. escalate to the other review state, return to any
  named step, or cancel.
- `done → ai_review` is **not** added (review only flows out of a running
  step or out of done into human_review, as today).

Tests sit alongside the existing block; cover every new edge.

---

## 6. Out of scope (explicitly)

- No new agent runtime — reuse `providers/`.
- No new knowledge store — reuse knowledge/decisions/observations.
- No parallelism work — parallel workers already exist.
- No goal decomposition changes.
- No automatic task cancellation on stale human QA. That belongs to a future
  task-deadline feature.
- License discussion — irrelevant for self-hosted; flagged once and dropped.

---

## 7. Pre-flight verifications (do before writing migration 047)

1. **SSE broadcast shape.** Read `apps/api/src/routes/sse.rs` end-to-end.
   Confirm `task_updates` insertions are broadcast in a form the Angular
   review-queue client already consumes. If not, the SSE wiring is part of
   SoW-1.
2. **`task_updates.kind` enum.** Confirm `question` is in the enum (per
   `001_schema.sql:343-352`); plan the `handover` addition migration for
   SoW-3.
3. **`previous_step_output` consumers.** Confirm `engine/prompt.rs` does
   **not** read the field today (it doesn't, per current source) so SoW-3
   knows it owns both producer and consumer.
4. **Provider session state.** Confirm
   [providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs)
   has no session-resume capability (it doesn't), validating the "re-run
   from scratch" decision in SoW-2.

---

## 8. Implementation order

1. SoW-0 (docs) — landed.
2. SoW-1 — sentinel + dedicated table + bridge row + state machine + guard.
3. SoW-3 — handover; defines `PreviousStepContext` for SoW-2's benefit.
4. SoW-2 — AI responder + accept-check + auto-resume.
5. SoW-4 — telemetry.
6. SoW-8 — stuck detector.
7. Defer SoW-6, SoW-7.
