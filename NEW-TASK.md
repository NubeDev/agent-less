# Adding and Managing a Job (Task)

Practical guide for getting a coding task from idea → committed code via the
Diraigent stack on a local Linux dev box.

> **Scope:** API at `http://localhost:3100`, dev auth via `X-Dev-User-Id`
> header, orchestra running locally with a `claude` agent. For prod deploys
> swap the auth headers for a real bearer token and adjust ports.

## TL;DR (lazy path)

For a throw-away demo (creates project, role, agent, key, membership, task,
and prints the orchestra launch command) use [scripts/throwaway-demo.sh](scripts/throwaway-demo.sh):

```bash
./scripts/throwaway-demo.sh                 # provision everything
. /tmp/diraigent-demo/state.env             # load $PROJ, $AGENT, $KEY, $TASK
                                            # then run the orchestra command it printed
```

Skip to **[Add a new task to an existing project](#add-a-new-task-to-an-existing-project)** if the
project/agent/key already exist.

---

## Concept map

```
Tenant ── owns ──► Project ── has ──► Tasks
   │                  │
   │                  └── grants ──► Members (Agent + Role)
   │
   └── owns ──► Agents (your `claude`, `codex`, etc.)
              └── api_key  ←─ orchestra authenticates with this
```

- **Project** — a code repo (`repo_url`) plus a playbook (`step → provider`).
- **Agent** — a runner identity (`kind=claude`, `kind=codex`…) with an API key.
- **Role** — permission set (e.g. `agent`). Attached to an agent on a project
  via a **membership**.
- **Task** — a unit of work in a project: title + spec + acceptance criteria.
- **Orchestra** — long-running daemon: polls API for `ready` tasks, spawns the
  provider CLI (`claude -p …`) in a git worktree, commits, merges, posts
  updates, transitions state.

State machine for a task (authoritative copy in
[state_machine.rs](libs/common-rust/diraigent-types/src/state_machine.rs)):

```
backlog → ready → <step_name> → done
                             ↘ cancelled
              ↘ wait:<next_step> → <next_step>     (pipeline advance)
done → human_review → done | ready | cancelled | wait:<next>
done → backlog                                      (manual reopen)
```

A task enters `ready` from `backlog`; orchestra then advances it through the
playbook's named steps (e.g. `implement`, `review`, `merge`), inserting
`wait:<next>` between steps, until it reaches `done`. There is no `draft`,
`in_progress`, or `blocked` state — failures are surfaced as `task_updates`
rows of kind `blocker`, not a state transition.

---

## Prereqs

| Service       | Port | Check                                    |
|---------------|------|------------------------------------------|
| Postgres      | 5488 | `docker ps \| grep diraigent-pg`         |
| API           | 3100 | `curl -fsS localhost:3100/v1/health`     |
| Web (optional)| 4280 | `curl -fsS -o/dev/null -w '%{http_code}\n' localhost:4280` |
| `claude` CLI  | —    | `claude --version` (Claude Code installed, OAuth done) |

Start them via the macOS compose stack or the Linux Makefile path documented in
[LOCAL-DEV.md](LOCAL-DEV.md).

Convenience shell vars used throughout:

```bash
API=http://localhost:3100/v1
DEV=00000000-0000-0000-0000-000000000001   # built-in dev user
H=(-H "X-Dev-User-Id: $DEV" -H 'Content-Type: application/json')
```

---

## One-time setup per project

### 1. Create the project

The project create endpoint is **`POST /v1`** (root), not `/v1/projects`.

```bash
PROJ=$(curl -sf -X POST "$API" "${H[@]}" -d '{
  "name": "throwaway",
  "slug": "throwaway",
  "repo_url": "https://example.invalid/local/throwaway.git",
  "integration_mode": "git"
}' | jq -r .id)
echo "PROJ=$PROJ"
```

Validation gotchas:
- `repo_url` must be `http(s)://`, `git@…`, or `ssh://`. `file://` is rejected.
  For a local-only throwaway, use a dummy URL like
  `https://example.invalid/<owner>/<name>.git` and place the repo on disk at
  the derived path: `$PROJECTS_PATH/<host>/<owner>/<name>` (see
  [Orchestra config](#configure--launch-orchestra) below).

### 2. Create or pick a role

```bash
ROLE=$(curl -sf "$API/roles" "${H[@]}" \
  | jq -r '.[] | select(.name=="agent") | .id')
[ -z "$ROLE" ] && ROLE=$(curl -sf -X POST "$API/roles" "${H[@]}" \
  -d '{"name":"agent","description":"task executor"}' | jq -r .id)
echo "ROLE=$ROLE"
```

### 3. Create an agent and **save its api_key**

```bash
RESP=$(curl -sf -X POST "$API/agents" "${H[@]}" -d '{
  "name": "orchestra-local",
  "kind": "claude"
}')
AGENT=$(echo "$RESP" | jq -r .id)
KEY=$(echo "$RESP" | jq -r .api_key)
echo "AGENT=$AGENT"
echo "KEY=$KEY"   # ← only returned once. Lose it = rotate the agent.
```

> If you lose the key, the agent has no DELETE endpoint. Just create a new
> agent with a timestamped name (`orchestra-local-$(date +%s)`).

### 4. Attach agent to project via a membership

```bash
curl -sf -X POST "$API/members" "${H[@]}" -d "{
  \"agent_id\": \"$AGENT\",
  \"role_id\":  \"$ROLE\",
  \"project_id\": \"$PROJ\"
}"
```

Tolerable failure: a `409 Conflict` means the membership already exists.

---

## Add a new task to an existing project

This is the loop you'll run dozens of times.

```bash
TASK=$(curl -sf -X POST "$API/$PROJ/tasks" "${H[@]}" -d '{
  "title": "Add greet function",
  "kind":  "feature",
  "context": {
    "spec": "Add fn greet(name: &str) -> String returning Hello, <name>!. Call from main with \"world\".",
    "files": ["main.rs"],
    "test_cmd": "rustc main.rs -o /tmp/t && /tmp/t",
    "acceptance_criteria": [
      "main.rs defines fn greet",
      "binary prints Hello, world!"
    ]
  }
}' | jq -r .id)
echo "TASK=$TASK"
```

Then move it from `backlog` → `ready` so orchestra will pick it up:

```bash
curl -sf -X POST "$API/tasks/$TASK/transition" "${H[@]}" \
  -d '{"state":"ready"}'
```

**Note the request shape:** `{"state":"…"}`, not `{"to_state":"…"}`.

### What goes in `context`

| Field                 | Required | Notes                                                  |
|-----------------------|----------|--------------------------------------------------------|
| `spec`                | yes      | Plain-language description. This is the user prompt.   |
| `files`               | no       | File scope. Out-of-scope edits get flagged in diff QA. |
| `test_cmd`            | no       | Run by agent to validate; failures surface in updates. |
| `acceptance_criteria` | no       | Checklist the agent self-verifies against.            |

### What `kind` should be

`feature`, `bug`, `chore`, `refactor`, `docs`, `test` — chooses the playbook /
system prompt. Default playbook works for all of them; pick the closest match.

---

## Configure & launch orchestra

Orchestra needs to know **where to find code on disk**. It computes a path
from `repo_url`:

```
$PROJECTS_PATH / <host> / <owner> / <repo>
```

So `https://example.invalid/local/throwaway.git` with
`PROJECTS_PATH=/tmp/diraigent-demo` resolves to
`/tmp/diraigent-demo/example.invalid/local/throwaway`. The repo **must already
exist** at that path (orchestra won't clone an unreachable host); for the
throwaway flow `scripts/throwaway-demo.sh` does this with a local `git init`.

Launch (long-running):

```bash
DIRAIGENT_API_URL=http://localhost:3100/v1 \
DIRAIGENT_API_TOKEN=$KEY \
AGENT_ID=$AGENT \
PROJECTS_PATH=/tmp/diraigent-demo \
MAX_WORKERS=1 \
RUST_LOG=info,diraigent_orchestra=debug \
./target/debug/orchestra
```

Or in the background (logs to a file):

```bash
nohup ./target/debug/orchestra > /tmp/orchestra.log 2>&1 &
```

> Use `./target/debug/orchestra`, not `cargo run -p diraigent-orchestra` —
> the workspace has multiple binaries and cargo refuses to pick.

You should see, in order:

```
INFO listening (workers=1)
INFO WebSocket connected
INFO poll: 1 ready task(s) in throwaway
INFO poll: picked up <id> "<title>"
INFO spawn <id>: step=implement model=… budget=… tools=… git=merge
INFO worker <id>: worktree ready at …/.claude/worktrees/task-<id>
INFO worker <id>: invoking claude (step=implement, …)
INFO worker <id>: provider 'claude-code' completed (exit_code=0, cost=$X.XX)
INFO worker <id>: diff stats: +N -M (scope ok)
INFO done <id> $X.XX turns=N Ns
INFO merged agent/task-<id> -> main
```

---

## Managing a job

### Inspect

```bash
# Single task with metadata (cost, tokens, stop_reason, …)
curl -s "${H[@]}" "$API/tasks/$TASK" | jq

# Updates posted by the agent (progress, blocker, …)
curl -s "${H[@]}" "$API/tasks/$TASK/updates" | jq

# All tasks for a project
curl -s "${H[@]}" "$API/$PROJ/tasks" | jq '.[] | {id, state, title}'
```

### Where the code lives

| Artifact                              | Location |
|---------------------------------------|----------|
| Per-task worktree (while running)     | `$PROJECTS_PATH/<host>/<owner>/<repo>/.claude/worktrees/task-<short>/` |
| Per-task branch                       | `agent/task-<short>` in the main repo |
| Final code (after merge, `git=merge`) | `main` of the main repo |
| Stream-json transcript                | `<orchestra-cwd>/logs/task-<short>.log` |
| Orchestra runtime log                 | wherever you redirected stdout |

After the task is `done`:

```bash
cd $PROJECTS_PATH/example.invalid/local/throwaway
git log --oneline -5            # see the merge commit
git show <commit>               # inspect the diff
```

If `git_strategy != merge` (e.g. `branch`), the code stays on
`agent/task-<short>` for human review:

```bash
git checkout agent/task-<short>
```

### Transitions you can drive

Most transitions are owned by orchestra. Human-driven ones:

```bash
# Cancel a stuck task (only valid from certain states)
curl -sf -X POST "$API/tasks/$TASK/transition" "${H[@]}" \
  -d '{"state":"cancelled"}'

# Re-open a task after a blocker by sending it back to backlog, then ready
curl -sf -X POST "$API/tasks/$TASK/transition" "${H[@]}" \
  -d '{"state":"backlog"}'
curl -sf -X POST "$API/tasks/$TASK/transition" "${H[@]}" \
  -d '{"state":"ready"}'
```

A `done` task cannot be re-driven. Create a follow-up task instead.

### Stopping orchestra

```bash
pkill -f 'target/debug/orchestra'
```

It will finish the in-flight worker first (SIGTERM is honoured).

### Cleaning up

```bash
# Drop cancelled tasks for a project
docker exec diraigent-pg psql -U diraigent -d diraigent \
  -c "DELETE FROM diraigent.task WHERE state='cancelled' AND project_id='$PROJ';"

# Remove an unmerged agent branch
cd $PROJECTS_PATH/example.invalid/local/throwaway
git branch -D agent/task-<short>
git worktree prune
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `POST /v1/projects` returns 404 | Use `POST /v1` (no `/projects` suffix). |
| `POST /v1/members` returns 500 | API needs the `ON CONFLICT (tenant_id, agent_id, role_id)` fix in `apps/api/src/repository/memberships.rs`. |
| Task stays in `ready`, no orchestra activity | `AGENT_ID` env doesn't match the agent that has membership; or `DIRAIGENT_API_TOKEN` doesn't match the agent's `api_key`. |
| Orchestra picks task, claude exits with code 1 in ~2 s, log file ~193 B | Old PTY/`script(1)` wrapper hit a TTY issue. Rebuild orchestra — the current `claude_code.rs` spawns `claude` directly without `script`. |
| `git fetch origin failed: 'origin' does not appear to be a git repository` | Cosmetic for local-only repos. Orchestra falls back to local state. |
| `no provider config for 'claude-code': 404` | Cosmetic — provider falls back to defaults (model, base URL). |

---

## See also

- [LOCAL-DEV.md](LOCAL-DEV.md) — full local dev environment setup
- [scripts/throwaway-demo.sh](scripts/throwaway-demo.sh) — idempotent
  provisioner used in this guide
- [apps/orchestra/src/providers/claude_code.rs](apps/orchestra/src/providers/claude_code.rs) — how the
  `claude` CLI is actually invoked
