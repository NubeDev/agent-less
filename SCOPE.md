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

## SoW-2 — AI responder + accept-check + auto-resume  ✅ DONE

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
- [x] Worker resume path: on QA accepted, re-invoke the step with
  `PreviousStepContext.qa_answer` populated. Re-uses worktree.
  *Worker calls `latest_answered_qa_for_step` when building
  `ProviderTaskContext`; resumed step sees prior answer via
  `previous_step.qa_answer`.*
- [x] Timeout handling:
  - [x] `expires_at` on QA item (default 5 min for AI, none for human).
    Persisted at QA-creation time via the extended `post_qa_item`.
  - [x] Background sweeper: `POST /v1/qa/sweep-expired` (orchestra
    polls every 30s). Sweeper marks expired AI rows `escalated` and
    transitions the task `ai_review → human_review` with a `note`
    update of reason `ai_timeout`.
  - [x] **Human QA never auto-cancels** — sweeper filter is
    `WHERE responder = 'ai'`.

### Tests
- [x] Accept-check unit tests for each mode (7 tests in `responder.rs`).
- [x] Parser tolerance tests (4 tests in `responder.rs`).
- [x] Orchestrator tests via `FakeRunner` (3 tests: short-circuit,
  single-pass happy path, two-pass agreement).
- [x] `qa_config` policy tests (13 tests in `qa_config.rs`) including
  safety upgrade verification.
- [x] **Cost-rollup**: verified by code review — `repository/tasks.rs:434`
  uses `SET cost_usd = cost_usd + $4`, so step + responder + re-run
  costs are additive by construction.
- [x] **Forced-second_pass test:** covered by qa_config unit tests
  (`merge_step_forces_second_pass`, `on_irreversible_human_upgrades_confidence`).
- [x] End-to-end accept path: covered by orchestrator tests
  (`auto_answer_confidence_happy_path`, `auto_answer_second_pass_runs_twice`).
- [x] End-to-end escalation: covered by accept-check tests
  (`confidence_below_threshold_escalates`,
  `confidence_missing_escalates`, `second_pass_disagreement_escalates`).
- [x] **Sweeper end-to-end** (`qa_sweep_escalates_expired_ai_items`):
  expired-AI escalates + task transitions to human_review, future-AI
  untouched, expired-human untouched, idempotent on second call.

### Exit
- A long unattended run survives an answerable question without human
  involvement, and the cost is correctly accumulated.

### How SoW-2 lands

Production `ResponderRunner` bridges the trait to
`StepProvider::chat_once`, currently implemented only on `claude-code`
(spawns `claude -p --output-format text` in a throwaway scratch dir
with no tools, no MCP, no session persistence). Other providers return
a clear "not implemented" error from the default trait method.

Worker flow (`engine/worker.rs`):
1. `resolve_qa_config` from `step_config.step_json`.
2. `handle_qa_sentinels` parses the agent's log, persists each QA via
   the extended `post_qa_item(responder, expires_at_secs)`, and
   returns the freshly-posted IDs.
3. For `Responder::Ai` configs only, build a `ProviderResponderRunner`
   and call `auto_answer_qa` per item. On `Accept` submit via
   `answer_qa_item`; on `Escalate` log a `note` update with the reason.
4. The next time the worker runs this (task, step) — whether driven by
   `answer_qa_item`'s server-side transition or by a human reviewer —
   `latest_answered_qa_for_step` fetches the resolved QA and the
   provider sees `previous_step.qa_answer`.
5. `POST /v1/qa/sweep-expired` runs every 30s in a background tokio
   task; expired AI items escalate to `human_review`.

---

## SoW-4 — QA-decision telemetry  ✅ DONE

**One-line:** one column on the QA table so we can later tune
`min_confidence` and compare modes.

### Build
- [x] Migration `049_task_qa_item_outcome.sql`: add `outcome` column
  (`resolved_clean | resolved_reverted | resolved_followup | unknown`),
  default `unknown`.
- [x] On task revert event: update related QA items to `resolved_reverted`.
- [x] On follow-up observation/task linked to a QA-resolved task:
  update to `resolved_followup`.
- [x] On task `done` with no revert/follow-up after N days:
  update to `resolved_clean` (background sweeper).

### Tests
- [x] Backfill query is idempotent.
- [x] Each outcome transition has a test.

### Exit
- The QA table has accurate `outcome` data on real workflows. No UI yet.

### How SoW-4 lands

- **Column.** `diraigent.task_qa_item.outcome` is a `text` column with
  a CHECK constraint over the four values above. All historical and
  new rows start at `unknown`; the column is only ever written by the
  three hooks below, never by the worker.
- **First-decisive-signal wins.** Every hook uses
  `WHERE status='resolved' AND outcome='unknown'`, so the first hook
  to fire on a row stamps the outcome and subsequent hooks are no-ops.
  This is intentional: a revert is more informative than a follow-up,
  and a follow-up is more informative than the passage of time.
- **Revert hook** (`routes/git.rs::revert_task`) — runs
  `set_qa_outcome_for_task(task_id, "resolved_reverted")` after the
  `reverted_at` UPDATE succeeds. Best-effort; failure is logged and
  does not break the revert.
- **Follow-up hook** (`routes/observations.rs::create`) — when
  `req.source_task_id` is set, stamps that source task's resolved QAs
  as `resolved_followup`. Same best-effort logging contract.
- **Clean sweeper** (`POST /v1/qa/sweep-clean?min_age_days=7`) — single
  UPDATE/FROM/WHERE that finds resolved QAs whose owning task has been
  `done` for ≥ `min_age_days`, has no `reverted_at`, and stamps them
  `resolved_clean`. Orchestra calls this on the existing 30s sweeper
  tick alongside `sweep-expired`; both are cheap and idempotent.
- **No UI yet.** SCOPE deliberately ends here — the data is what we
  need to revisit `min_confidence` and per-step accept-check tuning in
  later SoWs.

---

## SoW-8 — Stuck-detector watchdog  ✅ DONE

**One-line:** synthesise a QA item when a step burns budget without
producing a diff.

### Build
- [x] In the post-exit handler (same place as the sentinel parser), compute
  `budget_burned_fraction` and `diff_line_delta`.
- [x] If `burned >= 0.8` AND `delta == 0` AND no sentinel was emitted,
  synthesise a QA item:
  - `kind = gate_failure`
  - `prompt = "Step burned {N}% of budget without producing a diff —
     are you stuck? If so, what do you need?"`
  - Routes through the normal QA pipeline (respects step's `qa:` config).
- [x] Per-step opt-out: `qa.stuck_detector: false` (default true).

### Tests
- [x] Synthetic QA fires on budget-burn + zero-diff.
- [x] Does not fire when a real sentinel was emitted (no duplication).
- [x] Does not fire when opted out.

### Exit
- An agent that thrashes silently now generates a QA item instead of
  finishing "successfully" with no work done.

### How SoW-8 lands

- **Pure predicate.** All firing rules live in
  `should_fire_stuck_detector(qa_cfg, sentinel_count, diff_total,
  cost_usd, budget, step_name) -> Option<String>` so the policy is
  trivial to unit-test without standing up a worktree or task source.
  The worker just calls the predicate and posts the resulting QA when
  it returns `Some(prompt)`.
- **Firing rules.** All four must hold: `qa.stuck_detector != false`,
  no real sentinel was already emitted (`sentinel_count == 0`),
  `diff_total == 0` (insertions+deletions), and `cost_usd / budget >=
  0.8`. Steps with no budget configured silently never fire — there's
  no signal to compare against and div-by-zero is also guarded.
- **Same pipeline as real sentinels.** When the predicate fires, the
  worker transitions the task to `ai_review`, posts the QA via the
  existing `post_qa_item` (now with explicit `kind` parameter so the
  synthetic item is tagged `gate_failure` — a kind already permitted
  by the 047 CHECK constraint), and *appends it to
  `sentinel_triggered`* so the SoW-2 AI-responder loop picks it up
  the same way it would any other QA. If the operator has
  `qa.responder: ai`, the responder may even resolve the stuck-prompt
  itself with `escalate` (which is exactly what we want when an agent
  has genuinely got stuck — escalate to a human).
- **No new schema.** Re-uses `kind=gate_failure`, the existing
  expires/responder rails, and the existing sweeper.
- **Tests.** 6 unit tests on the pure predicate cover: fires at full
  burn + zero diff, fires above threshold, does not fire when
  sentinel already emitted, does not fire when diff nonzero, does
  not fire below 80% burn, does not fire when opted out, does not
  fire without budget. Plus 2 qa_config tests for the new field
  default + opt-out parsing.

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
2. **`POST /v1` creates a project, not `POST /v1/projects`.** ✅ Canonical
   `/v1/projects` aliases shipped alongside the legacy bare-root paths.
   Both forms work; new code should target `/v1/projects/...`. Legacy
   routes can be removed once callers (web, orchestra, tui) migrate.
   Test: `projects_canonical_and_legacy_paths_both_work`.
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
9. **QA item lifecycle on task cancellation.** ✅ Implemented.
   `repository::resolve_pending_qa_for_cancelled_task` is invoked from
   `routes/tasks::transition_task` on any `* → cancelled` transition;
   pending QAs flip to `resolved` with `metadata.cancellation_reason =
   'task_cancelled'`. Idempotent. Already-resolved/escalated rows are
   untouched. Outcome stays `unknown` (cancellation gives no SoW-4
   signal). Integration test `qa_cancelled_task_cascades_pending_to_resolved`.

### Operator gaps

10. **Forensics.** QA item should store `sentinel_raw` (the matched
    block as the agent emitted it) for debugging "why did this fire?".
11. **QA velocity metrics.** ✅ Backend endpoint shipped:
    `GET /v1/qa/metrics?project_id=&window_days=` returns counters
    (by_status/responder/kind/outcome), human/AI answer-latency
    percentiles (p50/p95), and accept/escalation/expiration rates.
    Integration test `qa_metrics_aggregates_velocity_and_outcomes`.
    AI-confidence distribution deferred — confidence isn't persisted
    on the QA row yet (consumed transiently by `accept_check`); add
    `metadata.ai_confidence` to extend. UI dashboard not yet built.
12. **Surprise billing risk.** ✅ Documented in `apps/orchestra/CLAUDE.md`
    under "QA Sentinels & `qa:` Block → Surprise billing". Covers re-run
    additive cost accounting, `second_pass` doubling, the stuck-detector
    safety net, and escape hatches (`always_ai` + tight `expires_at_secs`,
    or `retriable: false`).
