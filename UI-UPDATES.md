# SCOPE: Simplified UI — "Quick Job" flow

**Purpose:** make creating and managing a coding job a five-field,
one-screen experience without throwing away the existing Angular dashboard.
Companion to [SCOPE.md](SCOPE.md); land after SoW-2 unless prioritised.

**Decision (recorded so it's not re-litigated):** update the existing
Angular 21 app, do **not** build a parallel React app. Reasons:
- One auth flow, one SSE client, one API client to maintain.
- The confusion is information architecture (every concept surfaced equally:
  projects, agents, roles, members, playbooks, knowledge, decisions,
  observations, integrations, events, tasks). Switching framework doesn't
  fix IA.
- Power users still need the full dashboard for admin (agents, roles,
  knowledge). Two UIs = "one for me, one for everyone else" = worse than
  one confusing UI.
- Catppuccin theming + existing component library is free polish.

---

## UI-0 — IA audit  ☑ (code-walk; human screenshots still TODO)

**One-line:** quantify the confusion before fixing it.

### Do
- [x] Code-walk of `app.routes.ts` + sidebar nav captured below
  ("Audit findings" appendix). Human-timed click-through and annotated
  screenshots remain TODO for the engineer who will run the UX session.
- [x] Concrete hide/show list distilled (see appendix). UI-1 is
  implemented against that list.

### Exit
- A concrete list of what the "Quick Job" route must hide vs. show. ✅

---

## UI-1 — `/quick` flagship route  ☑

**One-line:** two screens. Submit a job. See its status. Nothing else.

### Verify first
- [x] SSE pattern reused: `ReviewSseService` (existing) is consumed by
  both new pages for live nudges; per-task state is refreshed by a 4-
  second polling loop on the detail page and 5 s on the list page (no
  per-task SSE channel today, polling is cheap).
- [x] Project/playbook lists are fetchable by an unprivileged user via
  the existing `GET /v1` (projects) and `GET /v1/playbooks` endpoints.

### Build — screen 1: New job
- [x] Angular standalone route at `/quick/new`
  ([apps/web/src/app/features/quick/quick-new.ts](apps/web/src/app/features/quick/quick-new.ts)).
- [x] Five fields in spec'd order. Project auto-selected when only one.
  Playbook hidden when only one.
- [x] Submit → POST `/v1/{project}/tasks` → redirect to `/quick/<id>`.
- [x] No mention of agents/roles/members/kinds/integrations/knowledge/
  decisions/observations on the form.
- [x] "Advanced…" link at the bottom navigates to `/dashboard` and flips
  the persisted UI-mode pref.

### Build — screen 2: Job detail
- [x] Route `/quick/:id`
  ([apps/web/src/app/features/quick/quick-detail.ts](apps/web/src/app/features/quick/quick-detail.ts)).
- [x] Header: title, state badge, current step (encoded into
  `running:<step>`), live elapsed time, total cost.
- [x] Live updates: 4 s poll + ReviewSSE listener for QA entered/left.
- [x] Pending QA panel: prompt rendered as plaintext (no v-html, no
  auto-link rendering), free-text or option buttons depending on
  `qa.options`, submits to `POST /v1/qa/{id}/answer`.
- [x] Last-update one-line summary.
- [x] Latest `kind=handover` task_update shown as collapsible.
- [x] Diff link: branch URL when `context.git_branch` + `repo_url`
  present; commit URL when `context.git_merge_sha` + `repo_url` present.
- [x] Cancel button with confirm dialog, posts a `cancelled` transition.
- [x] No turn counts, model names, raw provider output.

### Tests
- [x] Playwright spec [apps/web/e2e/quick.spec.ts](apps/web/e2e/quick.spec.ts)
  mocks the API and verifies: list renders three groups, new-job form
  submits + redirects, detail page shows pending QA and submits an
  answer via option click.
- [ ] Accessibility audit: form labels and roles are present in the
  templates; a real keyboard/screen-reader sweep against a running
  instance is still TODO.

### Exit
- A new user can create a task and answer a QA without reading docs. ✅
- Existing dashboard untouched and still reachable. ✅

---

## UI-2 — Default landing route  ☑

**One-line:** new logins land on `/quick`, not the full dashboard.

### Build
- [x] `DefaultRouteGuard`
  ([apps/web/src/app/core/guards/default-route.guard.ts](apps/web/src/app/core/guards/default-route.guard.ts))
  on `path: ''`. Authenticated users hitting `/` are redirected to
  `/quick` by default, or `/dashboard` when the persisted
  `diraigent.uiMode` localStorage key is `'advanced'`.
- [x] "Advanced…" link on all three /quick pages writes `'advanced'`;
  visiting `/quick` again writes `'quick'` on mount, so the toggle is
  bidirectional without an extra UI affordance.
- [x] Sidebar gains a top-level `/quick` link for users in advanced
  mode who want to flip back.

### Tests
- [ ] First-login redirect — covered manually; not yet in Playwright.
- [ ] Pref-stickiness across refreshes — covered manually.

### Exit
- Most users never see the existing dashboard unless they ask for it. ✅

---

## UI-3 — Quick-mode task list  ☑

**One-line:** between "new job" and "job detail", users need to see their
running and recent jobs.

### Build
- [x] Route `/quick` is the list; "new job" lives at `/quick/new`
  ([apps/web/src/app/features/quick/quick-list.ts](apps/web/src/app/features/quick/quick-list.ts)).
- [x] Three groups: **Needs you** (tasks with a pending QA),
  **Running** (state != done/cancelled/backlog), **Recent** (last 20
  done/cancelled, sorted by completion time).
- [x] Each row: title, state hint, time, cost. Click → `/quick/:id`.
- [x] Live updates: 5 s poll + ReviewSSE refresh on any event.
- [x] Big "+ New job" button top-right.

### Tests
- [x] Playwright spec asserts the three groups render and the new-job
  button is present. SSE-driven live promotion of a task into
  "Needs you" is exercised manually for now (the mock catch-all in
  the spec returns static data).

### Exit
- Users can answer pending QAs without hunting through the dashboard. ✅

---

## Deferred (after UI-3 lands)

- **Bulk-answer panel** for ops people who get many QAs at once.
- **QA history view** per task (timeline of all QAs, who answered,
  outcome).
- **Cost dashboard** in quick mode (per-task, per-project rollups).
- **Mobile layout** for the answer-QA flow (most likely use case is
  someone answering on phone).
- **Playbook picker preview** showing the step list so users know what
  will happen.
- **Inline playbook YAML editor** (only if/when the playbook-DB-revival
  decision in SCOPE.md Known Gaps #1 is made).

---

## UI-4 — Advanced job creation  ☑

**One-line:** a power-user "New job" form that exposes every knob the
backend supports — per-task session control, QA policy, knowledge scope,
verifications, reports, playbook choice, model/budget overrides.

**Why:** `/quick` deliberately hides everything. Advanced users (the
person who actually configured the project) need a single screen where
they can opt into the new SoW-1/2/3/4 features per job, not per playbook.

### Verify first
- [x] Confirm `task.context` JSONB accepts arbitrary overrides today
  (it does — used for `spec`, `files`, `test_cmd`, `acceptance_criteria`).
  Decide naming: `context.qa_override`, `context.session_mode`, etc.
- [x] Confirm the API exposes: playbook YAML for selected project
  (read-only), knowledge entries list, verifications list, reports
  list. Map each to its existing route. File missing endpoints as
  prerequisite tasks. (See `Known Gaps`.)

### Build — form sections (single page, collapsible groups)

- [x] **What** (mirrors `/quick`): spec, files, acceptance criteria.
  Pre-expanded.
- [x] **Playbook**
  - [x] Dropdown of project's playbooks.
  - [x] **Step preview** under the dropdown: render the chosen
    playbook's step list with each step's `model`, `budget`,
    `allowed_tools`, and `qa:` config visible. Read-only — links to
    the YAML in the repo.
  - [x] Per-task **model override** (free text, applies to all steps).
  - [x] Per-task **budget override** (USD cap across all steps).
- [x] **Session control** (new, exposes the per-step session behaviour)
  - [x] "Fresh session per step" toggle (default ON, matches today).
    OFF would attempt to reuse a single provider session across
    steps — flagged as experimental; emits a UI warning that not all
    providers support it. Stores intent in `context.session_mode:
    "per_step" | "shared"`.
  - [x] "Preserve worktree between runs" toggle (default ON, matches
    today). OFF wipes the worktree on retry.
- [x] **QA policy** (overrides per-step `qa:` from playbook, this run only)
  - [x] Responder: `ai | human | playbook_default` (default).
  - [x] Accept: `confidence | second_pass | always_human | always_ai |
    playbook_default`.
  - [x] Min confidence: numeric input, 0.0–1.0, default empty
    (=playbook).
  - [x] On irreversible: `human | playbook_default`.
  - [x] **Notice**: shows when override would weaken safety
    (e.g. setting `accept: confidence` on a Merge-profile playbook is
    blocked client-side; backend enforces too per SoW-2 policy).
- [x] **Knowledge scope**
  - [x] Multi-select of project knowledge entries to **pin** to this
    task (overrides semantic ranking).
  - [x] "Exclude these tags" multi-select for entries to keep out of
    context.
  - [x] Counter showing approx token cost of pinned entries.
- [x] **Verifications**
  - [x] Multi-select of project verifications to run as gates.
  - [x] "Fail fast on first verification fail" toggle.
  - [x] Custom `test_cmd` (free text, runs after playbook test_cmd).
- [x] **Reports**
  - [x] Multi-select: which report types to attach on completion
    (diff summary, cost breakdown, QA log, handover chain,
    knowledge-touched list).
  - [x] Default: diff summary + cost breakdown only.
- [x] **Integrations / agent**
  - [x] Agent picker (which registered agent to run as — defaults to
    project default).
  - [x] Integration toggles (which external tools this task may use:
    forgejo, github, etc.).
- [x] **Advanced** (collapsed by default)
  - [x] Raw `context` JSON editor for fields the form doesn't cover.
  - [x] Per-step env var overrides.
  - [x] MCP server overrides.

### Layout
- [x] Two-column on desktop: form left, **live preview** right showing
  the resolved playbook (per-step config after overrides applied,
  cost estimate, gate count, QA policy summary).
- [x] Validation runs on every change; submit button disabled with
  reason if any field is invalid.
- [x] "Save as template" button persists the form state to
  localStorage for next time.

### Tests
- [x] Playwright: each section toggles open/closed; overrides apply
  to preview in real time; safety-block fires when expected.
  ([apps/web/e2e/advanced.spec.ts](apps/web/e2e/advanced.spec.ts))
- [x] Unit tests on the override-merge logic (playbook + per-task →
  effective config).
  ([apps/web/e2e/override-resolver.spec.ts](apps/web/e2e/override-resolver.spec.ts))

### Exit
- A power user can configure every documented feature for one job on
  one screen, see the resolved config before submitting, and submit
  without leaving the page. ✅

---

## UI-5 — Advanced job detail  ☑

**One-line:** the existing dashboard task page, refreshed to expose
everything UI-4 lets you configure.

### Build
- [x] **Header**: title, state, current step, elapsed, cost (matches
  `/quick/:id`).
- [x] **Live step timeline** (replaces today's flat update list):
  rows per playbook step with status, duration, cost, model,
  collapse-to-expand for that step's QA events, handover, and diff.
- [x] **QA panel** (full version, not just pending):
  - Pending QAs at top with answer input.
  - History below: who asked, who answered, confidence (if AI),
    accept mode, outcome (`resolved_clean | resolved_reverted |
    resolved_followup`) per SoW-4.
- [x] **Handover chain**: every step's handover block, in order, with
  copy-to-clipboard.
- [ ] **Knowledge touched**: list of knowledge entries the run read,
  created, or modified. Click → opens entry in `/knowledge`.
  (Deferred — see `Known Gaps`: knowledge-touched provenance not yet
  emitted by worker.)
- [x] **Verifications**: pass/fail per gate, output snippet on fail.
- [x] **Reports**: links to generated reports.
- [x] **Playbook used**: collapsible YAML view (read-only) showing
  the exact step config that ran, with per-task overrides
  highlighted (`# override` / `# forced (SoW-2)`).
- [x] **Cost breakdown** per step + per provider call (responder
  calls separated from main step calls).
- [x] **Raw logs** link (existing functionality, kept).

### Tests
- [x] Playwright: live updates of timeline, QA panel, cost.
  ([apps/web/e2e/advanced.spec.ts](apps/web/e2e/advanced.spec.ts))
- [ ] Accessibility pass on collapsible sections.

### Exit
- Every backend feature has a visible representation on this page. ✅
  (Knowledge-touched panel waits on backend provenance.)

---

## UI-6 — Surface the existing menu items properly  ☑

The sidebar already lists Knowledge, Verifications, Reports, Playbooks,
Pipelines, Source, Audit. Most of these screens predate the SoW-1/2/3/4
work and don't show the new data. Quick passes:

- [x] **Playbooks page**: render the project's YAML playbooks
  (read-only), highlight any step with `qa:` config, show the step
  profile classification (Implement/Review/Merge/Dream). Link "edit"
  to the file path in the repo with a note "edit in git".
- [x] **Knowledge page**: add filter "touched by task" with a task
  picker. Add "created by AI" filter. (Client-side; backend lacks a
  `task_id` query param — see `Known Gaps`.)
- [x] **Reports page**: list reports generated from task runs.
  Filter by project / playbook / outcome. (Kind + task-run-only +
  task-id filters land; project / playbook / outcome remain — see
  `Known Gaps`.)
- [x] **Review Queue page**: ensure it surfaces `ai_review` and
  `human_review` items, with the QA prompt + answer UI inline.
- [x] **Audit page**: include QA events (created, AI-answered,
  human-answered, escalated, outcome-stamped) in the audit log.
  (UI registers `qa` entity_type + new action colors; backend
  emission unverified — see `Known Gaps`.)

### Exit
- No sidebar item leads to a stale page that ignores the new
  features. ✅

---

## Known Gaps (logged from BLOCK A/F verifications)

These are surfaced by the new advanced UI but require backend work to
fully land. Each is non-blocking for UI-4/5/6 \u2014 the UI degrades
gracefully (filters happen client-side on the page payload, empty
panels show "no data yet").

1. **Knowledge `task_id` query param** — ✅ resolved.
   `KnowledgeFilters` carries `task_id: Option<String>`, the SQL
   predicate in `KNOWLEDGE_FILTERS_WHERE` adds
   `($4::text IS NULL OR metadata->>'task_id' = $4)`, and
   `list_knowledge` binds `&f.task_id`. The Angular
   `KnowledgeApiService.list(category, tag, taskId)` forwards the
   param. Authoritative server-side filter; in-memory scoping is
   no longer required.

2. **Reports filters** — ✅ resolved. `ReportFilters` carries
   `status`, `kind`, `task_id: Option<Uuid>`, and `task_run_only:
   Option<bool>`; `REPORT_FILTERS_WHERE` and the bind in
   `list_reports` thread all four into SQL. The Angular
   `ReportsApiService.list({ status, kind, task_id })` already
   uses these — advanced-detail loads reports with
   `{ task_id: this.taskId }` and gets a server-filtered slice.
   `outcome` is still not a column on `report`, so any
   outcome-style filter remains client-side until reports gain a
   derived outcome field.

3. **QA audit events** — ✅ resolved. The QA lifecycle already
   wrote audit rows for `created` / `answered` / `escalated` /
   `cancelled_cascade` / `ai_confidence_stamped` via `fire_event` in
   `routes/qa.rs` and `routes/tasks.rs`. Added a `resolved` emission
   right after the status flip in `answer()` so the audit log shows
   the full lifecycle terminator (matching `AUDIT_ACTION_COLORS`
   which styles `resolved` green) — webhook subscribers that only
   care about closed-out QAs can listen on `resolved` directly.

4. **Knowledge-touched provenance for tasks** — ✅ resolved. Chose
   the `metadata.task_id` stamp path (no new join table). The worker
   exports `DIRAIGENT_TASK_ID` + `DIRAIGENT_PROJECT_ID` into the
   spawned agent process's env (`engine/worker.rs`), and `agent-cli
   knowledge` / `observation` / `decision` all auto-inject
   `metadata.task_id` from that env when the body doesn't already
   carry one (user-supplied wins, so cross-cutting notes can opt out
   by setting an explicit `task_id`). Combined with gap #1's
   `task_id` query param, the "Knowledge touched" panel and any
   task-scoped observation / decision listing now have full
   provenance for entries the agent posted while running the task.

5. **Playbook source URL** — ✅ resolved. `load_repo_playbooks` stamps
   `metadata.source_path` and a best-effort `metadata.source_url`
   (derived from `.git/config` origin + `HEAD` branch) onto every
   playbook parsed from `.diraigent/playbooks/`. The orchestra now has
   a `playbook_dispatch` WebSocket handler for
   `WsMessage::PlaybookRequest` (operations: list/get/create/update/
   delete) so the API's `/v1/projects/{id}/playbooks` proxy returns
   real data instead of timing out. Seeded DB playbooks still won't
   carry `source_url` — that requires a separate analyzer/seed
   migration if we want it on the defaults.

6. **Advanced-task overrides round-trip** — ⚠️ 11 of 12 fields shipped
   (`env`, `mcp`, `qa_override`, `model_override`, `budget_usd_cap`,
   `preserve_worktree`, `knowledge.{pin_ids,exclude_tags}`,
   `integrations_allowed`, `reports`, `session_mode`, and
   `verifications.{extra_test_cmd, fail_fast}` per ADR 0002 Tier 1).
   Only `verifications.ids` remains ignored — Tier 3 per ADR 0002,
   pending a runnable verification template subsystem (likely
   repo-side YAML symmetric with playbooks). UI-4 persists
   `qa_override`, `session_mode`,
   `preserve_worktree`, `knowledge.pin_ids`, `knowledge.exclude_tags`,
   `verifications.{ids,fail_fast,extra_test_cmd}`, `reports`,
   `integrations_allowed`, `model_override`, `budget_usd_cap`, `env`,
   and `mcp` into `task.context` JSONB.

   **Shipped**:
   - `qa_override` → `run_worker` fetches the task once and passes
     `context.qa_override` to `resolve_qa_config_with_override`
     ([engine/worker.rs](apps/orchestra/src/engine/worker.rs)).
   - `env` (UI canonical name) and the legacy `env_overrides` →
     `env_overrides_from_task` extracts the string-only sub-map and
     merges it into `step_config.env`. Task overrides win over
     playbook `step.env`.
   - `mcp` (UI canonical name) and the legacy `mcp_overrides` →
     `mcp_overrides_from_task` + `merge_mcp_servers` deep-merge
     per-server-name into `step_config.mcp_servers`, accepting both
     wrapped (`{"mcpServers": {…}}`) and bare (`{"name": {…}}`)
     shapes.
   - `model_override` (UI canonical) and the legacy `model` key →
     `task_overrides_from_context` in
     [engine/spawner.rs](apps/orchestra/src/engine/spawner.rs)
     extracts the model string with canonical-wins precedence and
     feeds it into `StepConfig::for_step`'s existing `task_model`
     slot. Whitespace / empty values are dropped.
   - `budget_usd_cap` → same helper extracts a finite, `> 0` cap;
     the spawner clamps `step_config.budget` downward against it
     (task can only lower the budget, never raise it). 8 unit
     tests in `engine::spawner::tests` cover precedence + edge
     cases (zero, negative, NaN, infinity, non-numeric).
   - `preserve_worktree` → `preserve_worktree_from_task` in
     [engine/scheduler.rs](apps/orchestra/src/engine/scheduler.rs)
     reads `context.preserve_worktree` (boolean, or stringy
     `true`/`1`/`yes`). Every `wm.remove_worktree()` cleanup call
     site in `process_reaped_task` (mid-pipeline merge success,
     all-done merge success, no-merge done, cancelled) now skips
     the cleanup when the flag is set; the cancelled-task comment
     also flips to mention preservation. Fetch failure defaults
     to "do not preserve" so a transient API error never leaks
     worktrees indefinitely. 7 unit tests cover the parsing edge
     cases.
   - `knowledge.pin_ids` / `knowledge.exclude_tags` →
     `apply_knowledge_filters` in
     [engine/prompt.rs](apps/orchestra/src/engine/prompt.rs)
     post-filters the `/v1/tasks/{id}/related` payload before
     `build_related_context_section` renders it. `pin_ids`
     restricts the `knowledge` array to entries whose `id` is
     listed; `exclude_tags` drops entries whose `tags` intersect
     the list. Decisions and observations pass through unchanged
     (the UI surfaces pinning for knowledge only). Empty lists
     skip the filter entirely so there is no clone cost in the
     common path. 6 unit tests cover pin-only, exclude-only,
     combined, identity, missing-knowledge-array, and
     pin-with-no-matches.
   - `integrations_allowed` → `apply_integrations_filter` in
     [engine/prompt.rs](apps/orchestra/src/engine/prompt.rs)
     filters `project_context.integrations` in place to entries
     whose `kind` matches the UI-supplied whitelist
     (e.g. `["forgejo", "github"]`). Applied after decrypt in
     both the full-context and trimmed-context branches so the
     filter survives `trim_context`. Empty / missing / non-array
     values are no-ops; entries with a missing `kind` are dropped
     when a filter is active because they cannot be on a
     whitelist. Matching is case-sensitive (UI sends canonical
     lowercase). 7 unit tests in `engine::prompt::tests` cover
     empty-allowed-noop, allowed-keeps-only-matching,
     drop-missing-kind, no-match-empties, missing-array-noop,
     non-object-context-noop, and case-sensitivity.

   All five reuse a single `api.get_task()` call up front; malformed
   values degrade silently so the advanced UI can never block worker
   progress. 11 unit tests in `engine::worker::tests` cover the env
   and MCP paths (extract, filter-non-strings, malformed, canonical
   vs legacy key, merge semantics, both UI shapes).

   **Naming mismatch resolved**: the earlier verification report
   listed `context.env_overrides` / `context.mcp_overrides`, but
   `buildTaskContext` actually emits `context.env` / `context.mcp`.
   The worker now accepts both names, with the UI canonical name
   winning when both are present.

   - `reports` → migration 050 adds `report.source` discriminator
     (`'researcher'` vs `'auto'`) and relaxes `prompt` / `created_by`
     NOT NULL. New `POST /v1/{project_id}/reports/auto` endpoint and
     `create_auto_report` repo helper (api side). `TaskSource::post_auto_report`
     + `list_qa_items_for_task` thread through all three impls
     (ProjectsApi / Orchestra / Local). Five pure generators in
     [engine/reports.rs](apps/orchestra/src/engine/reports.rs):
     `diff_summary`, `cost_breakdown`, `qa_log`, `handover_chain`,
     `knowledge_touched`. `emit_requested_reports` in
     [engine/scheduler.rs](apps/orchestra/src/engine/scheduler.rs)
     fires at the end of the AllDone branch (after merge / cleanup /
     preserve_worktree decisions) so generators see the final task
     state. Best-effort: per-kind failures log and continue; unknown
     kinds are silently dropped for forward compatibility. 10 unit
     tests cover each generator + the requested_kinds parser.

   - `session_mode` → ADR 0001 in [docs/adr/0001-task-session-mode.md](docs/adr/0001-task-session-mode.md).
     Migration 051 adds `session_id uuid` to `diraigent.task` (separate
     from `context` JSONB so a UI re-save can't clobber an in-flight
     session pointer) with a partial index on populated rows.
     [`build_session_handle`](apps/orchestra/src/engine/spawner.rs)
     allocates a UUID on the first shared-mode spawn, persists it via
     `POST /v1/tasks/{id}/session` BEFORE invoking the provider (so a
     crashed-spawn replay never orphans the prior session), and
     returns `Some(SessionHandle)` with `is_first_spawn` set correctly.
     Persistence failure degrades to per_step rather than blocking the
     task. New `session: Option<SessionHandle>` field on `TaskContext`
     threads the handle to providers without a trait API break.
     [claude_code::run_claude](apps/orchestra/src/providers/claude_code.rs)
     branches on the handle: `None` keeps `--no-session-persistence`
     (today's behaviour), first spawn uses `--session-id <uuid>`,
     subsequent spawns use `--resume <uuid>`. Other providers
     (anthropic/openai/copilot/ollama) log a one-time `info!` and
     continue exactly as today, honouring the UI's "silent fallback"
     promise observably. Responder backend stays per-spawn so QA
     reasoning doesn't pollute the implementation session. 5 unit
     tests cover the parser (default, explicit per_step, shared,
     case-insensitive, typos / non-strings).

   - `verifications.extra_test_cmd` + `verifications.fail_fast` → ADR
     0002 Tier 1 in [docs/adr/0002-task-context-verifications.md](docs/adr/0002-task-context-verifications.md).
     `verifications_policy_from_task` in
     [engine/scheduler.rs](apps/orchestra/src/engine/scheduler.rs)
     parses the block (object-only, trimmed non-empty cmd, fail_fast
     bool-or-stringy). `run_extra_test_cmd_and_record` shells out
     via `sh -c` in the task worktree with a 600s hard timeout,
     truncates each captured stream to 4 KiB, and records the outcome
     as a `diraigent.verification` row (kind=test, status=pass/fail,
     title=extra_test_cmd, detail=cmd, evidence={exit_code,
     duration_ms, stdout, stderr}) via a new
     `TaskSource::create_verification` wrapping the already-existing
     `POST /{project_id}/verifications` endpoint. When the command
     fails AND `fail_fast=true`, the AllDone branch skips merge /
     push / cleanup entirely, posts an explanatory comment, and
     transitions the task to `human_review`; the worktree is
     preserved on disk for inspection regardless of
     `preserve_worktree`. Reports still emit so cost / qa /
     handover artefacts land on the failure path. 9 parser unit
     tests cover missing block, missing cmd, empty / whitespace cmd,
     non-string cmd, default fail_fast, bool true, stringy true
     variants, falsey + unexpected fail_fast types, cmd trimming,
     and non-object block rejection.

   Each remaining field is a discrete worker change; until those land,
   the advanced UI must NOT be shipped as "supported" for them — it
   stores intent that the runtime silently discards. Remaining:
   `verifications.ids` (Tier 3 — deferred until a user asks; design
   captured in ADR 0002).

---

## Out of scope (explicitly)

- No parallel React app. (See decision at top.)
- No replacement of the existing dashboard. It remains available at
  `/dashboard` for admin and power use.
- No changes to authentication, role model, or API shape — UI work
  only consumes existing endpoints (with the small exceptions called
  out in UI-1 verify-first).
- No new design system. Reuse the Catppuccin + Tailwind tokens already
  in the project.

---

## Definition of done (whole programme)

**Quick mode (UI-0–3, shipped):**
- A new user lands on `/quick`, sees a 5-field form, submits a task,
  watches it run, answers any QA, and sees it merge — all without
  visiting the legacy dashboard or learning the terms
  agent/role/member/integration/knowledge/decision/observation.

**Advanced mode (UI-4–6):**
- A power user can configure every documented backend feature for one
  job on one screen (UI-4): playbook + per-task overrides, session
  control, QA policy, knowledge scope, verifications, reports,
  integrations, raw context overrides.
- The task detail page (UI-5) visibly represents every feature that
  was configured: step timeline, QA history with confidence/outcome,
  handover chain, knowledge touched, verification results, reports,
  resolved playbook YAML, cost breakdown separating responder calls.
- Every sidebar entry (UI-6) reflects the SoW-1/2/3/4 data — no stale
  pages.

**Both modes coexist:**
- The legacy dashboard remains reachable from a single "Advanced" link.
- Quick ⇆ Advanced toggle in header, choice persisted per user.

---

## Sequencing relative to SCOPE.md

**Shipped:**
- UI-0 (audit), UI-1 (`/quick` flagship), UI-2 (default route),
  UI-3 (quick task list) — all landed.

**Next (can run in parallel; different files):**
- **UI-4** (Advanced job creation). Depends on SoW-2 backend for the
  override-merge semantics (per-task QA overrides flow into the
  worker resolution). UI can be built against the current backend
  with override fields no-ops until SoW-2 finishes.
- **UI-5** (Advanced job detail). Depends on SoW-1/3/4 data being
  populated (all landed); benefits from SoW-2 (responder cost
  separation) but doesn't block on it.
- **UI-6** (sidebar pages refresh). Six independent quick passes
  — ship one at a time, any order.

**Dependencies between Advanced SoWs:**
- None hard. UI-4 and UI-5 share the override-merge code path —
  whoever ships first defines the shared resolver service.
- UI-6 Review-Queue pass should land before UI-5 so they don't
  diverge on how the QA history is rendered (extract shared
  component).

---

## Audit findings (UI-0 output)

Walked `apps/web/src/app/app.routes.ts` and `shared/components/sidebar/`.
The router exposes **22 top-level routes** (excluding redirects), each
backed by a distinct page with its own jargon. A first-time user must
choose between the following nav entries to get a task running:

`landing → dashboard → work → review → agents → knowledge → decisions →
playbooks → step-templates → goals → observations → reports → team →
pipelines → integrations → logs → verifications → source → audit →
settings → tenant-settings → chat`

### Terms that need prior knowledge to make sense
project, agent, role, member, playbook, step template, kind, package,
work item vs. task, decision, observation, knowledge entry, integration,
pipeline run, verification, scratchpad, handover, QA item, ai_review vs.
human_review.

### What `/quick` must HIDE (default view)
- Agents, roles, members, packages, kinds — never surfaced.
- Step templates, decisions, observations, knowledge, integrations,
  pipelines, verifications, audit, logs.
- Raw provider output, model names, turn counts, stop reasons.
- Project picker (auto-pick when one project; dropdown when multiple).
- Playbook picker (hide when only one available; default `standard`).

### What `/quick` must SHOW
- A 5-field new-job form (Project, What to do, Files, How to verify, Playbook).
- A live job list grouped: **Needs you / Running / Recent**.
- A job detail screen with: title, state badge, current step,
  elapsed time, total cost, pending QA prompt + answer input,
  latest handover, latest update line, diff link, cancel.
- A single "Advanced…" escape hatch to the existing dashboard.

### Wired hide/show enforcement
`apps/web/src/app/features/quick/*` consumes only:
`DiraigentApiService.getProjects`, `TasksApiService.{create,get,transition,
listUpdates,listForProject}`, `PlaybooksApiService.list`, the new
`QaApiService`, and `ReviewSseService` for live nudges. No other service
is imported — that is the architectural guard for "no jargon leaks in".