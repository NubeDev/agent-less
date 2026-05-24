# Diraigent — full UI-driven demo

End-to-end walkthrough that **exercises every shipped feature** of
Diraigent through the web UI on `http://localhost:4280`. By the end
you will have:

- A real project with a custom playbook
- Seeded **Knowledge**, **Decisions**, **Observations** (so the
  *Reference* nav group lights up)
- One task carrying **every `task.context.*` field**: `session_mode`,
  `preserve_worktree`, `verifications.{extra_test_cmd, fail_fast}`,
  `reports`, plus the per-step `qa:` policy that triggers both
  responder modes
- **Session A** — the AI responder resolves a QA, step auto-resumes
- **Session B** — you resolve a QA from the *Review Queue* UI
- A merged commit on the demo repo's `main`, auto-Reports under
  `/reports`, a verification row under `/verifications`, and a full
  audit trail under `/audit`

Tested 2026-05-24 on `main`.

> One thing this demo **does not** exercise: the `/pipelines` page.
> That's the **CI runs** surface (GitHub Actions / Forgejo Actions),
> not the agent step pipeline. CI integration requires a real remote,
> webhooks, and Actions runners — outside the scope of a single-host
> demo. The agent step pipeline is what `/playbooks` represents and
> is exercised end-to-end below.

---

## 0. Prerequisites

| Tool | Why | Verify |
|---|---|---|
| `rustup` + Rust stable | API, orchestra, demo binary | `cargo --version` |
| Docker | Postgres | `docker ps` |
| `pnpm` | Web UI | `pnpm --version` |
| `claude` CLI, **logged in** | The agent that runs steps | `claude --version` then `claude` once interactively |
| `git`, `curl`, `python3` | Provisioner script | standard |

If `claude` is not logged in, the orchestra will claim the task and
the first step will fail with a provider auth error. Run `claude` once
interactively before continuing.

---

## 1. Boot the platform

```bash
cd /path/to/diraigent
make start
```

The first run does `cargo build` + `pnpm install` + `pnpm ng build`,
so allow a minute. Subsequent starts are seconds.

| Service | URL | Purpose |
|---|---|---|
| Postgres | `localhost:5488` | Single source of state |
| API | <http://localhost:3100> | Axum REST + SSE, owns transitions |
| Swagger | <http://localhost:3100/swagger-ui/> | Browse all endpoints |
| Web UI | <http://localhost:4280> | What you'll use |

Sanity check:

```bash
curl -s http://localhost:3100/health/live          # → {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' \
     http://localhost:4280/                         # → 200
```

Open <http://localhost:4280>. Dev mode auto-authenticates you as the
"dev user" — no login screen. You land on `/quick` by default.

---

## 2. Provision the demo data (one script)

The provisioner does the boring REST plumbing for you. **It does
not run the agent**; it only seeds the database and the local git
repo so every UI view has content to display.

```bash
./scripts/web-demo.sh
```

What it creates:

| Surface | Created | What you'll see in the UI |
|---|---|---|
| Local git repo | `/tmp/diraigent-demo/example.invalid/local/web-demo/` with `Cargo.toml`, `static/index.html`, README | `/source` (after task starts) |
| **Playbook YAML** | `.diraigent/playbooks/web-with-qa.yaml` in the repo (3 steps, 2 different `qa:` blocks) | `/playbooks` |
| Project | `slug=web-demo` | Project switcher (top of every page); knowledge/decisions scope to it |
| Role | `web-demo-role` with execute/create/delegate/review/decide | n/a |
| Agent | `web-demo-agent-<ts>` + one-shot `api_key` saved to `state.env` | `/agents` |
| Membership | agent ↔ role | n/a |
| **Knowledge** | 3 entries: rust-style, project-layout, anti-pattern | `/knowledge` |
| **Decision** | 1 ADR: "HTTP framework will be picked at plan time via QA" | `/decisions` |
| **Observations** | 2 entries: insight + risk | `/observations` |
| **Task** | One task using `web-with-qa` playbook, with every `context.*` field set | `/work`, `/quick/<id>`, `/advanced/<id>` |

Output ends with the env block you need for step 4. Save it.

---

## 3. Tour the UI **before** the agent runs

This is the "References" tour you asked about. Open each in order so
you understand what the agent's context assembler will pull from:

1. <http://localhost:4280/knowledge> — three cards. The agent's
   semantic-rank context assembler will pull the most relevant ones
   into each step's prompt.
2. <http://localhost:4280/decisions> — the framework-choice ADR
   (status: *proposed*).
3. <http://localhost:4280/observations> — the insight + risk you
   seeded.
4. <http://localhost:4280/playbooks> — see `web-with-qa` listed.
   Click it to view the YAML. Note the **two different `qa:` blocks**
   on `plan` and `implement`.
5. <http://localhost:4280/work> — your one task appears in *Ready*.
6. <http://localhost:4280/quick/<TASK_ID>> (use the link printed by
   the provisioner). Quick detail view — spec, acceptance criteria,
   no activity yet.
7. <http://localhost:4280/advanced/<TASK_ID>> — same task, every
   panel visible: resolved config preview, knowledge-touched (empty
   until first step writes), QA panel (empty), Reports (empty),
   Verifications (empty), Handover chain (empty), Audit (just the
   create + transition rows).
8. <http://localhost:4280/agents> — your `web-demo-agent-<ts>`
   listed. No tasks claimed yet.
9. <http://localhost:4280/audit> — filter to this project; you'll
   see entries for the project create, role create, agent create,
   membership, knowledge × 3, decision × 1, observation × 2, task
   create, task transition.

> **`/pipelines` vs `/playbooks` — answered:** `/playbooks` is the
> agent step pipeline (this demo). `/pipelines` is CI run history
> from GitHub/Forgejo Actions and requires an integration to be
> configured under `/integrations`. The demo doesn't touch CI.

### You could also have created everything from the UI

Each artifact the script created via REST is also creatable in the
browser. The script saves you 5–10 minutes of clicking, but if you
want to see the forms:

| Artifact | UI page | Button |
|---|---|---|
| Project | `/settings` → Projects (or `POST /v1` via Swagger) | New |
| Knowledge | `/knowledge` | **New** (`n`) |
| Decision | `/decisions` | **New** (`n`) |
| Observation | `/observations` | **New** (`n`) |
| Playbook | `/playbooks` | **New** (`n`) → opens the builder |
| Step template | `/step-templates` | **New** |
| Task (quick) | `/quick/new` | full form |
| Task (advanced, every context field) | `/advanced/new` | full form with **QA policy**, **session mode**, **preserve worktree**, **pinned knowledge**, **verifications**, **reports**, **integrations**, **raw context JSON** sections — this is the kitchen sink |

The keyboard shortcuts come from [navigation.json](../../navigation.json);
press `?` anywhere in the UI to see the active set.

---

## 4. Start the orchestra

Now the agent. In a second terminal:

```bash
. /tmp/diraigent-demo/state.env
cd /path/to/diraigent
DIRAIGENT_API_URL=http://localhost:3100/v1 \
DIRAIGENT_API_TOKEN=$KEY \
AGENT_ID=$AGENT \
PROJECTS_PATH=$PROJECTS_BASE \
MAX_WORKERS=1 \
cargo run -p diraigent-orchestra
```

You'll see:

```
INFO claimed task <id> step=plan
INFO worktree allocated <path>
INFO spawning claude -p ...
```

Leave it running. Switch back to the browser.

---

## 5. Session A — AI resolves a QA

**Where to watch:** keep these tabs open side-by-side:

- `/work` (the task should move out of *Ready*)
- `/review` (will receive the QA shortly)
- `/advanced/<TASK_ID>` (full panel view)

### Phase 1 — `plan` runs and asks a question

The agent reads its prompt (which includes the seeded knowledge +
decisions + observations) and the step instructions explicitly tell
it to ask via the QA sentinel. Within ~30–60 s it exits with this
in the log:

```
DIRAIGENT_QA[<nonce>]: Which Rust HTTP framework should I use?
DIRAIGENT_QA_OPTIONS[<nonce>]: axum|actix-web
DIRAIGENT_QA_END[<nonce>]
```

### Phase 2 — Orchestra detects sentinel → `ai_review`

Post-exit, the worker validates the nonce, inserts:

- a row into `task_qa_item` (`kind=question, responder=ai, status=pending`)
- a bridge row into `task_updates` (`kind=question`)
- transitions task `<plan> → ai_review`

**In the UI:**

| Page | Change |
|---|---|
| `/work` | Task disappears from *Ready* group |
| `/review` | Task appears under **AI is answering** |
| `/advanced/<id>` | QA panel shows the pending question; state badge flips to `ai_review` |
| `/audit` | New `task` event with kind `transition` to `ai_review`, plus `qa` event `created` |

### Phase 3 — AI responder runs, accept-check accepts

The orchestra fires a cheap read-only `chat_once` call (claude-code,
no tools, no shell). The response carries `<confidence>0.NN</confidence>`.
Because `min_confidence=0.80` and the responder is usually well above
that for an opinionated question, the accept-check passes.

`POST /v1/qa/<id>/answer` writes the answer; `outcome=unknown` (will
be stamped later). Task transitions `ai_review → plan`.

**In the UI:**

| Page | Change |
|---|---|
| `/advanced/<id>` QA panel | Pending → resolved, shows the AI answer + confidence + timestamp |
| `/review` | Task leaves *AI is answering* group |
| `/audit` | `qa` events `ai_answered` + `resolved` |

### Phase 4 — `plan` step re-runs with the handover

Same worktree, no fresh clone. The next prompt prepends:

```
## Handover from plan
qa_answer: axum   (from the previous run of this step)
```

The agent writes `PLAN.md`, emits a `HANDOVER[<nonce>]: ...` block,
and exits cleanly. Pipeline advances to `wait:implement`.

**In the UI:**

| Page | Change |
|---|---|
| `/advanced/<id>` Handover panel | Shows the `plan → implement` handover note |
| `/advanced/<id>` Cost | Bumps to roughly `plan_run_1 + responder + plan_run_2` (cost rollup is **additive**, never reset) |
| `/source` (for the demo repo) | `PLAN.md` visible in the worktree branch |

### What you've just exercised

| Feature | Where in code | Where in UI |
|---|---|---|
| Sentinel parse with nonce gate | [apps/orchestra/src/engine/worker.rs:672](../../apps/orchestra/src/engine/worker.rs) | log + audit |
| `task_qa_item` insert + bridge `task_updates` row | [apps/api/src/routes/qa.rs](../../apps/api/src/routes/qa.rs) | `/review`, advanced QA panel |
| `ai_review` state | [libs/common-rust/diraigent-types/src/state_machine.rs](../../libs/common-rust/diraigent-types/src/state_machine.rs) | state badge |
| `qa:` config resolution | [apps/orchestra/src/engine/qa_config.rs](../../apps/orchestra/src/engine/qa_config.rs) | n/a (engine-only) |
| AI responder + accept-check | [apps/orchestra/src/engine/responder.rs](../../apps/orchestra/src/engine/responder.rs) | `/audit` AI-answered event |
| `HANDOVER` block parse + render | [apps/orchestra/src/engine/{worker,prompt}.rs](../../apps/orchestra/src/engine/) | advanced Handover panel |
| Cost rollup (no reset on re-run) | [apps/orchestra/src/engine/worker.rs](../../apps/orchestra/src/engine/worker.rs) | advanced Cost panel |

---

## 6. Session B — You resolve a QA from the UI

The `implement` step has `qa: { responder: human, accept: always_human }`,
so even a confident AI would not be allowed to answer. The orchestra
parks the task in `human_review` and waits for you.

### Phase 1 — `implement` runs and asks

The step prompt asks the agent to pick a TCP port via the sentinel:

```
DIRAIGENT_QA[<nonce>]: Which TCP port should the server bind?
DIRAIGENT_QA_OPTIONS[<nonce>]: 3000|8080|other
DIRAIGENT_QA_END[<nonce>]
```

### Phase 2 — Orchestra routes to `human_review`

Worker inserts `task_qa_item` with `responder=human, status=pending`,
transitions task to `human_review`. **No AI responder call is made.**

### Phase 3 — You answer in the browser

1. Open <http://localhost:4280/review>.
2. The task is now under **Needs you**. Click it.
3. The QA panel renders a form built from the `qa.options` array —
   three radio buttons: `3000`, `8080`, `other`.
4. Pick `8080`. Click **Submit answer**.
5. The browser POSTs `{ "answer": "8080", "answered_by": "<your user id>" }`
   to `/v1/qa/<id>/answer`. State transitions `human_review → implement`.

### Phase 4 — `implement` step re-runs and writes the server

Same worktree, handover prepended. The agent writes `src/main.rs`
(an axum server on port 8080 serving `static/index.html`), pins deps
in `Cargo.toml`, runs `cargo build`, posts artifacts and handover,
exits → `wait:review`.

**In the UI:**

| Page | Change |
|---|---|
| `/advanced/<id>` | QA panel shows your answer + your user id + timestamp |
| `/source` | `src/main.rs` and updated `Cargo.toml` |
| `/audit` | `qa` events: `created`, `human_answered`, `resolved` |

### Phase 5 — `review` runs, then `AllDone` triggers everything

The review step reads the diff, runs `cargo build` itself, posts
its `REVIEW: ...` artifact, and transitions to `done`. The
scheduler enters its **AllDone** branch:

1. **Verifications gate** ([scheduler.rs](../../apps/orchestra/src/engine/scheduler.rs)):
   `task.context.verifications.extra_test_cmd` runs in the worktree
   (`cargo build`) under a 600 s timeout. A `verification` row is
   inserted with `kind=test, status=pass|fail, evidence={exit_code,
   duration_ms, stdout, stderr}`.
2. If `fail_fast=true` and verification failed → set
   `verification_blocked_merge`, post comment, transition to
   `human_review`. (Not this demo — `cargo build` passes.)
3. **Auto-Reports** ([reports.rs](../../apps/orchestra/src/engine/reports.rs)):
   one `report` row per kind in `context.reports`, with
   `source="auto"`:
   - `diff_summary`
   - `cost_breakdown`
   - `qa_log` (both QAs, both responders, both outcomes)
   - `handover_chain` (plan → implement → review notes)
   - `knowledge_touched` (which seeded knowledge entries got pulled
     into prompts)
4. **Merge** worktree → `main` via the configured git strategy
   (`merge_to_default`).
5. **Cleanup** is **skipped** because `preserve_worktree=true` —
   you can still poke around `/tmp/diraigent-demo/example.invalid/local/web-demo/.git/worktrees/<task-id>/`.
6. Task transitions to terminal `done`.

**In the UI:**

| Page | Change |
|---|---|
| `/verifications` | One new row, `kind=test, status=pass` |
| `/reports` | Five new rows, `source=auto` |
| `/work` | Task moves to *Done* |
| `/audit` | `report` events × 5, `verification` event, `task` event `transition` to `done` |
| `/git` | The merge commit appears on the demo repo's `main` |

### Verify the actual deliverable

```bash
cd /tmp/diraigent-demo/example.invalid/local/web-demo
git log --oneline -5
cargo run &
sleep 1
curl -s http://localhost:8080/ | head -5
# → contents of static/index.html
```

---

## 7. Background sweepers (the QA outcome tier)

Two background tasks run on a 30 s tick in the orchestra:

- `POST /v1/qa/sweep-expired` — flips any AI-targeted QA past its
  `expires_at` to `status=escalated, outcome=unknown` and transitions
  the task `ai_review → human_review` with reason `ai_timeout`. **Human
  QAs never auto-cancel** (sweeper filters `WHERE responder='ai'`).
- `POST /v1/qa/sweep-clean?min_age_days=7` — finds resolved QAs
  whose owning task has been `done` ≥ N days with no revert and no
  follow-up observation, stamps them `resolved_clean`.

You can fire either by hand:

```bash
curl -s -X POST -H "X-Dev-User-Id: $DEV" \
  http://localhost:3100/v1/qa/sweep-expired | python3 -m json.tool
curl -s -X POST -H "X-Dev-User-Id: $DEV" \
  "http://localhost:3100/v1/qa/sweep-clean?min_age_days=0" | python3 -m json.tool
```

After `sweep-clean`, the demo's two resolved QAs should have
`outcome` flip from `unknown` to `resolved_clean` in the DB
(no UI for outcome yet — that's deferred by design per SoW-4).

To see the column directly:

```bash
make db-psql
# then:
SELECT kind, responder, status, outcome FROM diraigent.task_qa_item
 WHERE task_id = '<TASK from state.env>' ORDER BY created_at;
```

---

## 8. Coverage map — what just got exercised

Cross-referenced to [IMPROVEMENT.md](../../IMPROVEMENT.md) and
[SCOPE.md](../../SCOPE.md):

| Programme item | Path through this demo |
|---|---|
| SoW-1 sentinel + `task_qa_item` + `ai_review` | Session A phases 1–2; Session B phases 1–2 |
| SoW-2 AI responder + accept-check + auto-resume | Session A phase 3–4 |
| SoW-3 structured handover | Session A phase 4; Session B phase 4 (handover panel) |
| SoW-4 QA-decision telemetry | Step 7 (sweep-clean stamps `outcome`) |
| SoW-8 stuck detector | Not triggered in the happy path; would fire if the agent burned ≥80% budget with zero diff |
| `context.reports` auto-emit | Session B phase 5 |
| `context.verifications.extra_test_cmd` + `fail_fast` (ADR 0002) | Session B phase 5 |
| `context.session_mode=shared` (ADR 0001) | Same Claude Code session across all three steps; check `task.session_id` in DB |
| `context.preserve_worktree=true` | Worktree retained after merge (step 6 phase 5) |
| `agent-cli` `DIRAIGENT_TASK_ID` stamping on knowledge/observation/decision | If a step posts new knowledge mid-task, it's auto-tagged with `task_id` so `/knowledge?task_id=<id>` filters work |
| Audit of every QA event | `/audit` shows `created`, `ai_answered`/`human_answered`, `resolved` |

The nav surfaces touched (10 of 24):

`/work` · `/quick/:id` · `/advanced/:id` · `/review` · `/knowledge` ·
`/decisions` · `/observations` · `/playbooks` · `/agents` · `/audit` ·
`/reports` · `/verifications` · `/source` · `/git`

Not touched on purpose:

| Page | Why not |
|---|---|
| `/pipelines` | CI runs — needs GitHub/Forgejo Actions integration, out of scope |
| `/integrations` | No external service in the demo |
| `/webhooks` | No outbound delivery target |
| `/chat` | Free-form chat surface, not part of the task pipeline |
| `/goals` | The demo has one task; goals group tasks |
| `/team` | Single dev user |
| `/step-templates` | Templates compose into playbooks; the demo playbook inlines all step config |
| `/logs` | Available but redundant with `/audit` for this walkthrough |
| `/events` | Raw `task_updates` feed — also redundant |
| `/search` | Works but nothing specific to demo |

---

## 9. Reset between runs

```bash
# Just the task (keeps project + agent + seeded references):
. /tmp/diraigent-demo/state.env
curl -s -X DELETE -H "X-Dev-User-Id: 00000000-0000-0000-0000-000000000001" \
  "http://localhost:3100/v1/tasks/$TASK"

# Whole demo (project + agent + everything) + DB wipe:
make db-reset && make start
# then re-run:
./scripts/web-demo.sh
```

The provisioner is idempotent on project / role / agent / membership
(it reuses them from `state.env` when alive). The repo is always
rebuilt from scratch.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `make start` exit non-zero, "port in use" | Old API/web/PG still running | `make stop`; `lsof -i :3100 :4280 :5488` |
| Orchestra logs `provider error: not logged in` | Claude CLI not authenticated | Run `claude` interactively once |
| Task sits in `ready` forever | Orchestra not started, or `AGENT_ID` env wrong | Re-export `state.env`, restart orchestra |
| `/quick/new` shows "Could not load projects or playbooks" | Stale web build | `make build-web && make start` |
| Sentinel ignored, task merges without QA | Nonce mismatch, or sentinel not at column 0 | Tail orchestra log for `qa_nonce mismatch`; the playbook prompt explicitly templates `{{qa_nonce}}` — don't edit |
| AI responder always escalates | `min_confidence` too high, or model didn't self-report `<confidence>` | Lower `qa.min_confidence` in `web-with-qa.yaml` |
| Verifications page empty after AllDone | `extra_test_cmd` didn't run | Worktree must exist; check `task.context.verifications.extra_test_cmd` isn't empty |

---

## 11. Pointers for deeper exploration

- **Add `qa.stuck_detector: false`** to any step that legitimately
  produces no diff (e.g. a pure-review or dream step) to suppress
  SoW-8.
- **Add `context.tags`** to a task to group related work in
  Knowledge/Reports filters.
- **Mutate the playbook YAML live** — drop a new step into
  `.diraigent/playbooks/web-with-qa.yaml` and re-run; orchestra
  rereads on each task claim.
- **Set up `/integrations`** (GitHub PAT, Forgejo token) to populate
  `/pipelines` and start seeing CI runs alongside agent runs.
- See [diraigent-overview.md](../../diraigent-overview.md) for the
  full architecture, surface map, and before-vs-after delta.
