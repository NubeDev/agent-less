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

- A new user lands on `/quick`, sees a 5-field form, submits a task,
  watches it run, answers any QA, and sees it merge — all without
  visiting the legacy dashboard or learning the terms
  agent/role/member/integration/knowledge/decision/observation.
- The legacy dashboard is unchanged and reachable from a single
  "Advanced" link.

---

## Sequencing relative to SCOPE.md

- **UI-0** can happen at any time; do it before or during SoW-2.
- **UI-1** depends on SoW-1's QA endpoints and SSE work (both landed).
  Could start now in parallel with SoW-2's remaining backend work
  (different files, different contributors).
- **UI-2 and UI-3** depend on UI-1.
- All UI work depends on SoW-2 being **at least partly** landed only
  if you want the AI-responder flow visible in the UI — otherwise UI-1
  works fine with human-only QAs (which is what's wired today).

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