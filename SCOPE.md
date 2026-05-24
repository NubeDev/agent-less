# SCOPE: AI-responder + handover loop

**Purpose:** action-ready implementation tracker derived from
[IMPROVEMENT.md](IMPROVEMENT.md). One row per ship-unit, in order.
Tick boxes as you land. Do not reorder without updating IMPROVEMENT.md.

**Conventions:**
- Each SoW is a single PR (or commit on main, per CLAUDE.md "small/confident
  changes" rule) unless explicitly split.
- "Verify" steps must run before "Build" steps in the same SoW.
- Acceptance criteria are testable. If you can't write the test, the criterion
  is wrong.

---

## SoW-0 — Doc fixes  ✅ DONE

- [x] README.md state-machine diagram corrected.
- [x] NEW-TASK.md state-machine diagram + body language corrected.
- [x] IMPROVEMENT.md rewritten with peer-review corrections.

**Exit:** committed on main.

---

## SoW-1 — QA sentinel loop, human-only responder  ✅ DONE

**One-line:** detect "agent needs a decision" post-exit, persist as structured
QA item, route to a human via the existing review queue.

### Verify first
- [x] Read `apps/api/src/routes/sse.rs` end-to-end. Document whether new
  `task_updates` insertions are already broadcast in a shape the Angular
  review-queue client subscribes to. If not, SSE wiring is part of this SoW.
- [x] Confirm `task_updates.kind` enum contains `question`
  (`apps/api/migrations/001_schema.sql:343-352`).
- [x] Confirm
  [providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs)
  reads the per-task log file post-exit (around `claude_code.rs:55`) — this
  is the hook point for the sentinel parser.

### Build
- [x] Migration `047_task_qa_item.sql`: table with columns per
  [IMPROVEMENT.md §3 SoW-1 AC1](IMPROVEMENT.md). Tenant-scoped, FKs to task
  and project, indexes on `(task_id, status)` and `(status, expires_at)`.
- [x] `apps/api/src/repository/qa_items.rs` — CRUD mirroring
  `repository/observations.rs`.
- [x] `apps/api/src/routes/qa.rs` — `GET /v1/qa?status=pending`,
  `POST /v1/qa/{id}/answer` (validates via `state_machine::can_transition`,
  transitions `human_review → <step>`).
- [x] Wire into `routes/mod.rs`.
- [x] State machine: add `is_review_state()` predicate + amended arms +
  tests. See [IMPROVEMENT.md §5](IMPROVEMENT.md).
- [x] `apps/api/src/routes/tasks.rs` (~`:516`): accept new transitions.
- [x] `engine/pipeline.rs` (~`:180`): symmetric `AiReview` arm next to
  existing `HumanReview` arm (no-op for now; worker just parks).
- [x] Sentinel parser module in
  `apps/orchestra/src/providers/sentinel.rs` (new): parses post-exit log
  for `DIRAIGENT_QA[<nonce>]: ... DIRAIGENT_QA_END[<nonce>]` and
  `DIRAIGENT_QA_OPTIONS[<nonce>]: a|b|c`. Per-step nonce minted in worker
  and embedded in system prompt.
- [x] Hook parser into
  [providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs)
  post-exit path. Return parsed sentinels alongside existing result.
- [x] **Agent-ignored-stop guard** in `worker.rs`: if any sentinel was
  found, force transition to `ai_review` *regardless of exit code, diff
  size, or `output.is_error`*. Add log line warning when this overrides a
  "successful" exit.
- [x] QA item insertion writes a bridge row to `task_updates` of kind
  `question` with `metadata.qa_item_id`.
- [x] System-prompt addendum in `engine/prompt.rs` instructing the agent
  how/when to emit the sentinel with the supplied nonce.

### Tests
- [x] State-machine unit tests for every new edge.
- [x] Parser unit tests: missing end-tag, wrong nonce, no-column-0,
  multi-line body, two QA blocks in same log.
- [x] **Forged-sentinel test:** log containing a sentinel with wrong nonce
  → no QA item created.
- [x] **Ignored-stop test:** log contains valid sentinel **and** a diff
  was committed and exit code = 0 → task ends in `ai_review`, no merge.
- [x] Integration test: POST `/v1/qa/{id}/answer` from a human transitions
  task back to the original step name.

### Exit
- A failing claude run that asks `DIRAIGENT_QA: "use postgres or sqlite?"`
  produces a row in `task_qa_item`, surfaces in the existing review UI,
  and resumes the same step on human answer. No AI responder yet.

---

## SoW-3 — Structured handover  ✅ DONE

**One-line:** the previous step writes a `HANDOVER` block; the next step's
prompt prepends it. Defines `PreviousStepContext` for SoW-2.

### Build
- [x] Migration `048_task_update_kind_handover.sql`: add `handover` to
  `task_updates.kind` enum.
- [~] `PreviousStepContext { from_step: String, handover: Option<String>,
  qa_answer: Option<String> }` in `apps/orchestra/src/engine/mod.rs` (or
  new module). Replace `ProviderTaskContext.previous_step_output:
  Option<String>` at:
  - `apps/orchestra/src/engine/worker.rs:629`
  - `apps/orchestra/src/engine/mod.rs:227`
  - `apps/orchestra/src/chat.rs:650`
  *Deferred to SoW-2.* SoW-3 implements the equivalent behavior directly
  in `build_user_prompt` by loading the latest `kind=handover`
  task_update; the dedicated struct refactor lands when SoW-2 needs to
  attach `qa_answer` alongside `handover`.
- [x] Extend the sentinel parser from SoW-1 to also recognise
  `HANDOVER[<nonce>]: ... HANDOVER_END[<nonce>]`.
- [x] Worker persists handover as a `task_updates` row of kind `handover`.
- [x] On the next step's run, worker loads the latest `handover` row for
  the task and populates `PreviousStepContext.handover`.
- [x] `engine/prompt.rs` consumer: when `PreviousStepContext` has any
  populated field, prepend a `## Handover from <from_step>` section to
  the prompt.
- [x] System-prompt addendum (all steps) instructing the agent to close
  with a `HANDOVER` block.

### Tests
- [x] Parser test: handover-only log, QA-only log, both-in-same-log.
- [x] End-to-end: step A writes handover → step B prompt contains it.

### Exit
- A two-step playbook visibly carries decisions across steps without the
  second step re-deriving them from the worktree.

---

## SoW-2 — AI responder + accept-check + auto-resume  🚧 PARTIAL

**One-line:** AI answers the QA first; trusted answers re-run the step
automatically; untrusted answers escalate to human.

### Verify first
- [x] Confirm worktree reuse (`git/worktree.rs:60`) survives a step
  re-run without manual intervention. Write a smoke test if uncertain.
  *Verified: `worktree.rs:60-62` reuses existing worktree by path.*
- [x] Confirm cost rollup in `worker.rs:640` area is additive across
  multiple step runs for the same task. **If it resets, fix that as a
  prerequisite.** *Verified: `repository/tasks.rs:434` uses
  `SET cost_usd = cost_usd + $4` (additive).*

### Build
- [x] Per-step `qa:` YAML schema parser in
  `apps/orchestra/src/engine/qa_config.rs` (new): validate
  `accept ∈ {confidence, second_pass, always_human, always_ai}`,
  `min_confidence ∈ [0.0, 1.0]`, `responder ∈ {ai, human}`,
  `on_irreversible ∈ {human, ai}`.
- [x] **Defaults policy enforcement:**
  - No `qa:` block on a step → behave as `responder: human` (safe rollout;
    existing playbooks unchanged).
  - `StepProfile::Merge` OR `on_irreversible: human` → force
    `accept: second_pass` at runtime even if YAML says `confidence`.
    Log the upgrade. (`forced_second_pass: true` flag set.)
- [x] Responder driver in
  `apps/orchestra/src/engine/responder.rs` (new): pure parser
  (`parse_responder_output`) + pure `accept_check` + `ResponderRunner`
  trait + `auto_answer_qa` orchestrator. The trait abstracts the LLM
  call so production wiring can land separately.
- [x] Accept-check implementation:
  - [x] `confidence`: parse `<confidence>0.NN</confidence>` from
    responder output; accept iff `>= min_confidence` (default 0.85).
  - [x] `second_pass`: two responder calls; accept iff
    `normalize(primary) == normalize(secondary)` (case-insensitive
    whitespace-collapsed). LLM-judge for free-text divergence
    deferred to a follow-up SoW.
  - [x] `always_human` / `always_ai`: trivial.
- [x] `TaskSource::answer_qa_item(qa_id, answer, target_step)` —
  threads the existing `POST /v1/qa/{id}/answer` endpoint through
  the API/orchestra/local sources so the worker can submit AI
  answers via the same validated path humans use.
- [ ] Worker resume path: on QA accepted, re-invoke the step with
  `PreviousStepContext.qa_answer` populated. Re-uses worktree.
  *Requires production `ResponderRunner` impl — see follow-up below.*
- [ ] Timeout handling:
  - [ ] `expires_at` on QA item (default 5 min for AI, none/very long
    for human).
  - [ ] Background sweeper (or inline check on next poll): expired AI
    QA → escalate to `human_review` with `reason = ai_timeout`.
  - [ ] **Human QA never auto-cancels.**

### Tests
- [x] Accept-check unit tests for each mode (7 tests in `responder.rs`).
- [x] Parser tolerance tests (4 tests in `responder.rs`).
- [x] Orchestrator tests via `FakeRunner` (3 tests: short-circuit,
  single-pass happy path, two-pass agreement).
- [x] `qa_config` policy tests (13 tests in `qa_config.rs`) including
  safety upgrade verification.
- [ ] **Cost-rollup regression test:** task runs step ($X), responds to
  QA ($Y), re-runs step ($Z); task cost = $X+$Y+$Z.
- [ ] **Forced-second_pass test (end-to-end):** YAML declares
  `accept: confidence` on a `Merge`-profile step; runtime upgrades to
  `second_pass`. (Currently covered at unit level in qa_config tests.)
- [ ] End-to-end: agent asks "postgres or sqlite", responder answers
  "sqlite" with confidence 0.9, step re-runs and merges.
- [ ] End-to-end: responder confidence 0.5 → escalation to human_review.

### Exit
- A long unattended run survives an answerable question without human
  involvement, and the cost is correctly accumulated.

### Follow-up needed to complete SoW-2 (next session)

The pure engine, accept-check, and API plumbing are landed and tested.
What remains is the **production responder runner** that bridges
`ResponderRunner::run(pass, prompt) -> Result<String>` to an actual
LLM. Three viable approaches, in increasing scope:

  1. **Subprocess via claude-code `--print` mode** — quickest, but
     ties responder to a single provider.
  2. **Add `chat_once(prompt) -> String` to `StepProvider`** — implement
     for anthropic + openai (HTTP clients already exist), `NotImplemented`
     stub for claude-code/copilot/ollama. Cleanest long-term shape.
  3. **Direct HTTP shim in `responder.rs`** — bypasses provider
     abstraction, picks one model per project, simplest to test.

Once a runner exists, BLOCK E wiring is small: in `worker.rs` after
`handle_qa_sentinels`, resolve `qa_config` from `step_config.step_json`,
build the runner, call `auto_answer_qa` for each new qa_item, and on
`Accept` call `api.answer_qa_item(...)` (which transitions task back
to the step). `PreviousStepContext` refactor lives in the same commit
since `qa_answer` is consumed by the next worker invocation.

---

## SoW-4 — QA-decision telemetry  ⬜

**One-line:** one column on the QA table so we can later tune
`min_confidence` and compare modes.

### Build
- [ ] Migration `049_task_qa_item_outcome.sql`: add `outcome` column
  (`resolved_clean | resolved_reverted | resolved_followup | unknown`),
  default `unknown`.
- [ ] On task revert event: update related QA items to `resolved_reverted`.
- [ ] On follow-up observation/task linked to a QA-resolved task:
  update to `resolved_followup`.
- [ ] On task `done` with no revert/follow-up after N days:
  update to `resolved_clean` (background sweeper).

### Tests
- [ ] Backfill query is idempotent.
- [ ] Each outcome transition has a test.

### Exit
- The QA table has accurate `outcome` data on real workflows. No UI yet.

---

## SoW-8 — Stuck-detector watchdog  ⬜

**One-line:** synthesise a QA item when a step burns budget without
producing a diff.

### Build
- [ ] In the post-exit handler (same place as the sentinel parser), compute
  `budget_burned_fraction` and `diff_line_delta`.
- [ ] If `burned >= 0.8` AND `delta == 0` AND no sentinel was emitted,
  synthesise a QA item:
  - `kind = gate_failure`
  - `prompt = "Step burned {N}% of budget without producing a diff —
     are you stuck? If so, what do you need?"`
  - Routes through the normal QA pipeline (respects step's `qa:` config).
- [ ] Per-step opt-out: `qa.stuck_detector: false` (default true).

### Tests
- [ ] Synthetic QA fires on budget-burn + zero-diff.
- [ ] Does not fire when a real sentinel was emitted (no duplication).
- [ ] Does not fire when opted out.

### Exit
- An agent that thrashes silently now generates a QA item instead of
  finishing "successfully" with no work done.

---

## Deferred (Tier 3)

- **SoW-6: MCP `ask` tool.** Requires orchestra to become an MCP host
  (separate process or in-proc server) + JSON-RPC streaming back into the
  running step. Real cost. Revisit only if sentinel reliability falls
  below ~95% in production.
- **SoW-7: N-of-M responder fan-out.** Run K models per QA, accept on
  majority. Multiplies QA cost by K. Revisit only when SoW-4 telemetry
  shows baseline error rate is unacceptable.

---

## Definition of done (whole programme)

- Long unattended runs survive answerable questions without human
  involvement on Tier-1 paths.
- Irreversible/merge steps never auto-accept on `confidence` alone.
- Stored-prompt injection cannot forge a QA item or a handover.
- QA decisions are persisted with enough metadata to tune the
  accept-check empirically.
- No regression in existing playbooks (those without a `qa:` block
  continue to use `human_review` exclusively).

---

## Known gaps / future work (not in this programme)

Captured here so they don't get lost. Triage when convenient; none block
SoW-2.

### Architectural debt

1. **Playbook DB → YAML (commit 5c7a4d2, April 9 2026).** ~700 lines of
   DB-backed playbook infrastructure deleted in favour of
   `.diraigent/playbooks/*.yaml`. Operator-UX regression (no UI editing
   without a git commit). Worth revisiting as "hybrid: YAML defaults +
   DB overrides table" — model after GitHub Actions repo settings.
2. **`POST /v1` creates a project, not `POST /v1/projects`.** Surprising
   to every new user. Add `/v1/projects`, deprecate root path.
3. **`memberships.rs` `ON CONFLICT` 500 bug** flagged in
   NEW-TASK.md troubleshooting. Verify still real; fix or remove the note.
4. **Stale state-machine vocabulary** (`draft`/`in_progress`/`blocked`)
   probably still lingers in comments, UI strings, or older migrations.
   20-min `grep -ri 'in_progress\|draft' apps/` audit + sweep.
5. **Port duplication.** Compose stack uses 4200/8082/5433; `make start`
   uses 4280/3100/5488. Fine if intentional; document the why or unify.
6. **License: SSPL.** Contributor/fork friction. Not urgent.

### Behavioural gaps the AI-responder loop creates

7. **Weak models may never use the sentinel.** Plan to monitor
   "tasks failed silently" vs "tasks asked a QA" ratio after launch;
   if QA rate is ~0, the system prompt isn't working.
8. **No rate-limit on QA emissions.** A confused agent could emit dozens
   of sentinels in one log. Add max-per-step cap (e.g. 3) in the parser
   with a WARN if exceeded.
9. **QA item lifecycle on task cancellation.** If a task is cancelled
   while a human QA is pending, cascade `qa_item.status = resolved
   (task_cancelled)`. Add to SoW-2 or as a follow-up.

### Operator gaps

10. **Forensics.** QA item should store `sentinel_raw` (the matched
    block as the agent emitted it) for debugging "why did this fire?".
11. **QA velocity metrics.** Average human answer time, AI confidence
    distribution, accept rate. Needs SoW-4 telemetry + a dashboard query.
12. **Surprise billing risk.** SoW-2's re-run re-pays the full step
    budget (no provider session resume exists). Document this in the
    user-facing playbook docs so people aren't surprised by the cost
    of `second_pass` on a budget-heavy step.
