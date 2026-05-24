# Setup + worked demo — AI-resolve and human-resolve QA

End-to-end walkthrough: stand the system up, then run **one task that
asks two questions** — the first answered by the AI responder, the
second routed to a human via the review queue. The task itself builds
a tiny **Rust + Axum web server** that serves a **static `index.html`
home page**, so you get a real BE/FE deliverable out the other end.

Tested on Linux against `main` (2026-05-24). Mac users with the
keychain-aware launcher can use [startup/start.sh](../../startup/start.sh)
instead of the Makefile flow.

---

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| `rustup` + Rust stable | API, orchestra, demo binary | `cargo --version` |
| Docker | Postgres in a container | `docker ps` |
| `pnpm` | Web UI | `pnpm --version` |
| `claude` CLI, logged in | The agent that runs steps | `claude --version` |
| `git`, `curl`, `python3`, `jq` | Demo scripting | all standard |

The orchestra spawns `claude -p` for every step, so **`claude login`
must be done at least once on this machine**. No login = the orchestra
will start, claim the task, and immediately fail the step with an auth
error from the provider.

---

## 2. Stand up the platform

```bash
cd /path/to/diraigent
make start              # Postgres :5488 + API :3100 + Web :4280
```

The first run does `cargo build`, `pnpm install`, and `pnpm ng build`,
so give it a minute. Subsequent starts are seconds.

Verify:

```bash
curl -s http://localhost:3100/health/live          # → {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' \
     http://localhost:4280/                         # → 200
open http://localhost:4280   # or: xdg-open
```

You're auto-logged in as the dev user via the `X-Dev-User-Id` header
(auth is disabled in dev mode). The web UI lands on `/quick` by default.

If you need a fresh DB: `make db-reset && make start`.

### What's running, and on what port

| Process | Port | Purpose |
|---|---|---|
| Postgres | 5488 | Single source of state — `tasks`, `task_qa_item`, `report`, `verification`, `knowledge`, `decisions`, `observations`, … |
| API (`apps/api`) | 3100 | Axum REST + SSE, owns `transition_task` and the state machine |
| Web (`apps/web`) | 4280 | Angular UI (proxied to API via `proxy.conf.json`) |
| Orchestra (`apps/orchestra`) | — | Scheduler + worker pool. **Started separately** below, talks to the API as an agent |

---

## 3. Provision a project, agent, role, and one task

Run the demo provisioner — it creates a tiny local git repo, registers
a project pointing at it, mints an agent + API key, grants execute
authority, and creates one `ready` task with a **custom playbook**
that exercises both QA responder modes.

```bash
./scripts/web-demo.sh
```

What it does:

1. Wipes and re-creates `/tmp/diraigent-demo/example.invalid/local/web-demo/`
   as a fresh git repo with one file (a placeholder `Cargo.toml`).
2. Copies a project-local playbook **`web-with-qa.yaml`** into the
   repo's `.diraigent/playbooks/` so the orchestra finds it by name.
3. Creates a project with `slug=web-demo` pointing at the dummy URL
   `https://example.invalid/local/web-demo.git` (provisioner sees the
   `.git` on disk and skips clone — see [LOCAL-DEV.md](../../LOCAL-DEV.md)
   "API endpoint quirks").
4. Creates a role with `[execute, create, delegate, review, decide]`
   authorities.
5. Creates an agent named `web-demo-agent-<ts>` and saves the
   one-shot `api_key` to `/tmp/diraigent-demo/state.env`.
6. Binds the agent to the role (membership).
7. Creates one task using the `web-with-qa` playbook, with `spec` and
   `acceptance_criteria` driving the AI toward asking two questions
   it cannot answer alone.
8. Transitions the task `backlog → ready`.

After it finishes you'll have:

```text
/tmp/diraigent-demo/
├── state.env                       ← PROJ, AGENT, KEY, TASK ids
└── example.invalid/local/web-demo/ ← the actual git repo
    ├── .diraigent/playbooks/web-with-qa.yaml
    ├── Cargo.toml
    └── README.md
```

### The custom playbook (key piece)

`web-with-qa.yaml` has three steps; **steps 1 and 2 carry `qa:`
blocks**:

```yaml
- name: plan
  qa:
    responder: ai           # AI tries to answer
    accept: confidence
    min_confidence: 0.80
    expires_at_secs: 300

- name: implement
  qa:
    responder: human        # human is the only responder
    accept: always_human

- name: review
  # no qa: block → human_default → if the reviewer asks, a human answers
```

In normal use you'd put `qa:` on every step. The split here is
deliberate: it makes the two demo sessions trivially repeatable.

---

## 4. Start the orchestra

In a second terminal:

```bash
. /tmp/diraigent-demo/state.env
cd /path/to/diraigent

DIRAIGENT_API_URL=http://localhost:3100/v1 \
DIRAIGENT_API_TOKEN=$KEY \
AGENT_ID=$AGENT \
PROJECTS_PATH=/tmp/diraigent-demo \
MAX_WORKERS=1 \
cargo run -p diraigent-orchestra
```

The orchestra logs `claimed task <id> step=plan`, allocates a git
worktree, and spawns `claude -p`.

Leave it running. Watch the UI at <http://localhost:4280/work>.

---

## 5. Session A — AI-resolves a QA

The `plan` step's instructions ask the agent to commit to a
framework choice. The system prompt tells it to use the QA sentinel
when in doubt:

```
DIRAIGENT_QA[<nonce>]: Should I use axum or actix-web?
DIRAIGENT_QA_OPTIONS[<nonce>]: axum|actix-web
DIRAIGENT_QA_END[<nonce>]
```

What happens, in order:

1. **Step exits.** Worker reads its log, finds the sentinel with a
   matching nonce, inserts a row into `task_qa_item`
   (`kind=question, responder=ai, status=pending`) plus a bridge
   `task_updates` row of kind `question`. Task transitions
   `<plan> → ai_review`. Worker freed.
2. **UI updates** (SSE + 4 s poll). The task moves from *Work* to the
   **Review Queue → "AI is answering"** group. You can open it and
   watch in real time.
3. **AI responder fires.** Cheap read-only `chat_once` against
   `claude-code` with the question plus the project context. Returns
   something like `<confidence>0.92</confidence> axum`. Accept-check
   sees `0.92 ≥ 0.80` → accept.
4. **`POST /v1/qa/{id}/answer`** marks the QA `status=resolved`,
   `outcome=unknown` (will be stamped later by the revert / follow-up /
   clean sweeper). Task transitions `ai_review → <plan>`.
5. **Same worktree, same step re-runs** with `PreviousStepContext`
   carrying `qa_answer = "axum"` prepended as `## Handover from plan`.
   Cost rolls up: step #1 + responder + re-run all bill into
   `task.cost_usd`.
6. The agent now writes the plan, emits a `HANDOVER[<nonce>]: …`
   block summarising the choice, and exits. Pipeline advances to
   `wait:implement`.

**Where to look:**
- UI: <http://localhost:4280/review> → click the task → scroll to the
  QA panel; you'll see the question, the AI answer with its
  confidence, and the resolution timestamp.
- DB: `make db-psql` then
  ```sql
  SELECT kind, responder, status, outcome,
         answered_by, answered_at
    FROM diraigent.task_qa_item
   WHERE task_id = '<TASK from state.env>'
   ORDER BY created_at;
  ```
- Audit: `/audit` filtered by your project.

If the AI's self-reported confidence had been below `0.80`, accept-check
would have escalated to `human_review` instead. To force that path
without changing the playbook, set `min_confidence: 0.99` and re-run.

---

## 6. Session B — Human resolves a QA

The `implement` step has `responder: human`, so even if the AI is
sure, the orchestra **will not** auto-answer. The step prompt
intentionally leaves a port-binding decision up to the user:

```
DIRAIGENT_QA[<nonce>]: Which TCP port should the server bind?
DIRAIGENT_QA_OPTIONS[<nonce>]: 3000|8080|other
DIRAIGENT_QA_END[<nonce>]
```

What happens:

1. **Step exits.** Worker finds the sentinel, inserts the QA with
   `responder=human, status=pending`, transitions task to
   `human_review`. No AI responder call.
2. **UI.** Task moves to **Review Queue → "Needs you"**.
3. **You answer.** Click the task, pick `8080` from the radio buttons
   (the form is rendered from `qa.options`), submit. The browser POSTs
   to `/v1/qa/{id}/answer` with `{ "answer": "8080", "answered_by":
   "<your user id>" }`.
4. State transitions `human_review → <implement>`. Step re-runs with
   the answer in its handover block.
5. The agent writes `src/main.rs` (axum server binding 8080, serving
   `static/index.html`), runs `cargo build`, posts the diff and
   handover, and exits → `wait:review`.

The review step does its diff review and either approves (`done`) or
rejects (`ready`). On approval the task hits **AllDone**, auto-reports
fire (`diff_summary`, `cost_breakdown`, `qa_log`), and the worktree
merges to `main` on the demo repo.

You can verify the deliverable end-to-end:

```bash
cd /tmp/diraigent-demo/example.invalid/local/web-demo
git log --oneline -5
cargo run &                                    # starts on the chosen port
curl -s http://localhost:8080/ | head -5       # serves index.html
```

---

## 7. What you just exercised

Every IMPROVEMENT.md SoW played a part in those two sessions:

| Path | SoW |
|---|---|
| Sentinel parse + `task_qa_item` insert + `ai_review` state | SoW-1 |
| `qa:` config resolution, AI responder, accept-check, resume | SoW-2 |
| `HANDOVER` block prepended to the re-run prompt | SoW-3 |
| `outcome` column on the resolved QA rows (stamping comes later) | SoW-4 |
| Auto-reports on AllDone | post-IMPROVEMENT (context.reports) |
| Worktree reuse across re-runs | pre-existing |

See [diraigent-overview.md §4 "What's new vs what was already there"](../../diraigent-overview.md)
for the full delta table.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `make start` exits non-zero, port in use | Old API/web/PG still running | `make stop`, `lsof -i :3100 :4280 :5488` |
| Orchestra logs `provider error: not logged in` | `claude` CLI not authenticated on this machine | `claude login`, restart orchestra |
| Task stuck in `ready`, orchestra logs nothing | `AGENT_ID` env not set, or membership missing | Re-run `./scripts/web-demo.sh` (idempotent), re-export `state.env` |
| `/quick/new` shows "Could not load projects or playbooks" | Stale build — fix landed; check `git log --oneline apps/web/src/app/features/quick/quick-new.ts` includes the playbook-fetch fix | `make build-web` |
| Sentinel ignored, task merges with no QA | Forged nonce, or sentinel not at column 0 of a fresh line | Tail the orchestra log for `qa_nonce mismatch`; rephrase the spec to be more leading |
| AI responder never accepts | `min_confidence` too high, or the prompt isn't asking the agent to self-report `<confidence>` | Lower `min_confidence`; system prompt addendum in [apps/orchestra/src/engine/prompt.rs](../../apps/orchestra/src/engine/prompt.rs) |
| Want to wipe everything between runs | Demo + DB | `./scripts/web-demo.sh` rewrites the repo; `make db-reset && make start` wipes DB |

---

## 9. Pointers for going further

- Add a `qa: { stuck_detector: false }` line to any step where the
  agent legitimately produces no diff (e.g. a pure-review step).
- Add `context.verifications.extra_test_cmd` to the task to gate the
  merge on `cargo test`; combine with `fail_fast: true` to escalate
  to `human_review` on failure (ADR 0002).
- Add `context.session_mode: shared` to the task to keep the same
  Claude Code session across all three steps (ADR 0001).
- Add `context.reports: [diff_summary, cost_breakdown, qa_log,
  handover_chain, knowledge_touched]` to populate `/reports` after
  every run.
- Add `context.preserve_worktree: true` if you want to inspect the
  worktree after merge (handy when debugging a failed step).
