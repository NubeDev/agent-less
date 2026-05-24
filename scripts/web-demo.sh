#!/usr/bin/env bash
# Rust web-server demo with two QA modes (AI-resolve + human-resolve).
# Companion to docs/usage/SETUP-AND-DEMO.md — read that for the walkthrough.
#
# Provisions:
#   - local git repo at /tmp/diraigent-demo/example.invalid/local/web-demo
#   - project-local playbook `web-with-qa.yaml` with two qa-bearing steps
#   - project (slug=web-demo), role, agent + api_key, membership
#   - one ready task driving a tiny axum web server + static index.html
#
# Idempotent: blows away the repo, reuses agent + api_key from state.env when
# the agent still exists on the API.

set -euo pipefail

DEV="${DEV_USER_ID:-00000000-0000-0000-0000-000000000001}"
ROOT="${DIRAIGENT_API_URL_ROOT:-http://localhost:3100}"
API="$ROOT/v1"
PROJECTS_BASE="${PROJECTS_BASE:-/tmp/diraigent-demo}"
SLUG="${SLUG:-web-demo}"
REPO_HOST="${REPO_HOST:-example.invalid}"
REPO_OWNER="${REPO_OWNER:-local}"
REPO_URL="https://$REPO_HOST/$REPO_OWNER/$SLUG.git"
DEMO="$PROJECTS_BASE/$REPO_HOST/$REPO_OWNER/$SLUG"
H_DEV=(-H "X-Dev-User-Id: $DEV" -H 'Content-Type: application/json')

die() { echo "error: $*" >&2; exit 1; }

# ── 0) Sanity ────────────────────────────────────────────────────
curl -sf "$ROOT/health/live" >/dev/null \
  || die "API not reachable at $ROOT — run 'make start' first"

# Preserve state.env (agent api_key only returned once at creation).
PREV_STATE=""
if [ -f "$PROJECTS_BASE/state.env" ]; then
  PREV_STATE=$(mktemp)
  cp "$PROJECTS_BASE/state.env" "$PREV_STATE"
fi

# ── 1) Local repo ────────────────────────────────────────────────
echo "==> repo at $DEMO"
rm -rf "$PROJECTS_BASE"
mkdir -p "$DEMO/.diraigent/playbooks" "$DEMO/static"
if [ -n "$PREV_STATE" ]; then
  cp "$PREV_STATE" "$PROJECTS_BASE/state.env"
  rm -f "$PREV_STATE"
fi

cat > "$DEMO/Cargo.toml" <<'TOML'
[package]
name = "web-demo"
version = "0.0.1"
edition = "2021"

[dependencies]
# the implement step will pin a server framework and write src/main.rs
TOML

cat > "$DEMO/README.md" <<'MD'
# web-demo

Tiny Rust web server + a static home page. The implementation is
written by Diraigent — see `docs/usage/SETUP-AND-DEMO.md` in the
host repo.
MD

# Placeholder static page so the repo is non-empty even before
# implementation lands. The agent should overwrite as needed.
cat > "$DEMO/static/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>web-demo</title>
<h1>web-demo</h1>
<p>Served by a Rust web server.</p>
HTML

# ── 2) Project-local playbook with two qa: blocks ───────────────
cat > "$DEMO/.diraigent/playbooks/web-with-qa.yaml" <<'YAML'
title: Web demo with QA
trigger_description: "plan → implement → review (QA-bearing)"
initial_state: ready
tags: [demo]
metadata:
  git_strategy: merge_to_default

steps:
  - name: plan
    budget: 3.0
    allowed_tools: readonly
    context_level: minimal
    on_complete: next
    # Session A: AI is allowed to answer its own framework question.
    qa:
      responder: ai
      accept: confidence
      min_confidence: 0.80
      expires_at_secs: 300
    description: |
      ## Your Job: PLAN

      1. `{{agent_cli}} task {{task_id}}` — read the spec.
      2. `{{agent_cli}} claim {{task_id}}`.
      3. You must pick a Rust HTTP framework. You do not have a
         preference recorded in the spec. **Ask via the QA sentinel
         exactly once.** Emit, at column 0, on three consecutive lines:

         ```
         DIRAIGENT_QA[{{qa_nonce}}]: Which Rust HTTP framework should I use?
         DIRAIGENT_QA_OPTIONS[{{qa_nonce}}]: axum|actix-web
         DIRAIGENT_QA_END[{{qa_nonce}}]
         ```

         Then exit. The orchestra will route the question to the AI
         responder, accept its answer if confident, and re-run this
         step with the answer prepended to your prompt as
         `## Handover from plan`.
      4. On the re-run, do NOT re-ask. Read the handover, write a
         one-paragraph plan as `PLAN.md` describing the chosen
         framework, the file layout (`src/main.rs`, `static/`),
         and the route shape (`GET /` → static index).
      5. `{{agent_cli}} artifact {{task_id}} "$(cat PLAN.md)"`.
      6. End with a HANDOVER block summarising the choice:

         ```
         HANDOVER[{{qa_nonce}}]: framework=<axum|actix>, route GET / serves static/index.html.
         HANDOVER_END[{{qa_nonce}}]
         ```
      7. `{{agent_cli}} transition {{task_id}} done`.

      **Rules:** No `cargo` invocation. No code changes outside
      `PLAN.md`. Stay in your worktree.

  - name: implement
    budget: 10.0
    allowed_tools: full
    context_level: full
    on_complete: next
    # Session B: human-only responder. The port choice MUST escalate.
    qa:
      responder: human
      accept: always_human
    description: |
      ## Your Job: IMPLEMENT

      1. `{{agent_cli}} task {{task_id}}`, `{{agent_cli}} claim {{task_id}}`.
      2. Read `PLAN.md` for the framework + layout.
      3. You need a TCP bind port. The spec deliberately does not
         specify one. **Ask via the QA sentinel exactly once** — a
         human will answer:

         ```
         DIRAIGENT_QA[{{qa_nonce}}]: Which TCP port should the server bind?
         DIRAIGENT_QA_OPTIONS[{{qa_nonce}}]: 3000|8080|other
         DIRAIGENT_QA_END[{{qa_nonce}}]
         ```

         Then exit. The orchestra will park the task in `human_review`.
         On re-run, read the handover for the answer.
      4. Write `src/main.rs`: a server using the planned framework,
         binding `0.0.0.0:<port>`, serving `static/index.html` at
         `GET /` (and the `static/` dir at `/static/*` if the
         framework makes that one-liner). Pin minimal deps in
         `Cargo.toml`.
      5. `cargo build` must succeed. Retry up to 3 times on failure.
         Still failing? `{{agent_cli}} blocker {{task_id}} "<err>"`,
         then `{{agent_cli}} transition {{task_id}} ready`.
      6. `{{agent_cli}} artifact {{task_id}} "build output"`.
      7. HANDOVER block summarising what landed.
      8. `{{agent_cli}} transition {{task_id}} done`.

  - name: review
    budget: 3.0
    model: claude-sonnet-4-6
    allowed_tools: readonly
    context_level: minimal
    on_complete: next
    description: |
      ## Your Job: REVIEW

      1. `{{agent_cli}} task {{task_id}}`, `{{agent_cli}} claim {{task_id}}`.
      2. `git diff {{project.default_branch}}...HEAD`.
      3. Check: `src/main.rs` exists, uses the framework named in
         `PLAN.md`, binds the port given in the implement handover,
         serves `static/index.html` at `/`. `cargo build` must
         succeed (run it).
      4. `{{agent_cli}} artifact {{task_id}} "REVIEW: <findings>"`.
      5. Decision:
         - APPROVED: `{{agent_cli}} transition {{task_id}} done`
         - CHANGES NEEDED: `{{agent_cli}} blocker {{task_id}} "<what>"`,
           then `{{agent_cli}} transition {{task_id}} ready`.
YAML

# ── 3) Initial commit ────────────────────────────────────────────
(
  cd "$DEMO"
  git init -q -b main
  git config user.email demo@local
  git config user.name  demo
  git add .
  git commit -q -m 'init: web-demo scaffold + qa playbook'
)
echo "    $DEMO @ $(git -C "$DEMO" rev-parse --short HEAD)"

# ── 4) Project (idempotent by slug) ──────────────────────────────
echo "==> project"
PROJ=$(curl -sf "$API/by-slug/$SLUG" "${H_DEV[@]}" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null \
  || true)
if [ -z "$PROJ" ]; then
  PROJ=$(curl -sf -X POST "$ROOT/v1" "${H_DEV[@]}" -d "{
    \"name\":\"$SLUG\",
    \"slug\":\"$SLUG\",
    \"description\":\"web-server demo with QA\",
    \"repo_url\":\"$REPO_URL\",
    \"default_branch\":\"main\",
    \"git_mode\":\"standalone\"
  }" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "    project: $PROJ (created)"
else
  echo "    project: $PROJ (reused)"
fi

# ── 5) Role ──────────────────────────────────────────────────────
ROLE_NAME="web-demo-role"
echo "==> role"
ROLE=$(curl -sf "$API/roles" "${H_DEV[@]}" \
  | python3 -c "import sys,json
for r in json.load(sys.stdin):
    if r.get('name')=='$ROLE_NAME': print(r['id']); break")
if [ -z "$ROLE" ]; then
  ROLE=$(curl -sf -X POST "$API/roles" "${H_DEV[@]}" -d "{
    \"name\":\"$ROLE_NAME\",
    \"description\":\"web demo\",
    \"authorities\":[\"execute\",\"create\",\"delegate\",\"review\",\"decide\"]
  }" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "    role:    $ROLE (created)"
else
  echo "    role:    $ROLE (reused)"
fi

# ── 6) Agent (reuse from state.env if alive) ─────────────────────
AGENT=""; KEY=""
if [ -f "$PROJECTS_BASE/state.env" ]; then
  PREV_AGENT=$(grep -E '^AGENT=' "$PROJECTS_BASE/state.env" | cut -d= -f2- || true)
  PREV_KEY=$(  grep -E '^KEY='   "$PROJECTS_BASE/state.env" | cut -d= -f2- || true)
  if [ -n "$PREV_AGENT" ] && [ -n "$PREV_KEY" ] \
     && curl -sf "$API/agents/$PREV_AGENT" "${H_DEV[@]}" >/dev/null 2>&1; then
    AGENT="$PREV_AGENT"; KEY="$PREV_KEY"
    echo "==> agent:   $AGENT (reused from state.env)"
  fi
fi
if [ -z "$AGENT" ]; then
  AGENT_NAME_UNIQUE="web-demo-agent-$(date +%s)"
  AJSON=$(curl -sf -X POST "$API/agents" "${H_DEV[@]}" -d "{
    \"name\":\"$AGENT_NAME_UNIQUE\",
    \"kind\":\"claude\",
    \"capabilities\":[\"rust\"],
    \"metadata\":{\"runtime\":\"orchestra\"}
  }")
  AGENT=$(echo "$AJSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  KEY=$(  echo "$AJSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_key",""))')
  [ -n "$KEY" ] || die "agent created but no api_key returned"
  echo "==> agent:   $AGENT (created as $AGENT_NAME_UNIQUE)"
fi
echo "    key:     ${KEY:0:14}..."

# ── 7) Membership ────────────────────────────────────────────────
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/members" "${H_DEV[@]}" \
  -d "{\"agent_id\":\"$AGENT\",\"role_id\":\"$ROLE\"}")
case "$HTTP" in
  200|201|204) echo "    membership: ok (created)" ;;
  409)         echo "    membership: ok (exists)" ;;
  *)           die "membership create returned HTTP $HTTP" ;;
esac

# ── 8) Task ──────────────────────────────────────────────────────
echo "==> creating task"
TASK=$(curl -sf -X POST "$API/$PROJ/tasks" "${H_DEV[@]}" -d '{
  "title":"Build a tiny Rust web server serving a static home page",
  "kind":"feature",
  "playbook_id":"web-with-qa",
  "context":{
    "spec":"Build a minimal Rust HTTP server that serves the existing static/index.html file at GET /. Pick a small framework (axum or actix-web — ask). Pick a bind port (ask). Pin minimal deps. The crate is already named web-demo in Cargo.toml.",
    "files":["Cargo.toml","src/main.rs","static/index.html"],
    "test_cmd":"cargo build --manifest-path Cargo.toml",
    "acceptance_criteria":[
      "cargo build succeeds",
      "src/main.rs starts an HTTP server on the chosen port",
      "GET / returns the bytes of static/index.html with Content-Type text/html"
    ],
    "reports":["diff_summary","cost_breakdown","qa_log","handover_chain"]
  }
}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -sf -X POST "$API/tasks/$TASK/transition" "${H_DEV[@]}" \
  -d '{"state":"ready"}' >/dev/null
echo "    task:    $TASK (ready)"

# ── 9) Persist state ─────────────────────────────────────────────
cat > "$PROJECTS_BASE/state.env" <<EOF
PROJECTS_BASE=$PROJECTS_BASE
DEMO=$DEMO
PROJ=$PROJ
AGENT=$AGENT
ROLE=$ROLE
KEY=$KEY
TASK=$TASK
EOF
echo "    saved:   $PROJECTS_BASE/state.env"

cat <<EOF

==> Ready. Start the orchestra in another terminal:

    . $PROJECTS_BASE/state.env
    cd $(pwd)
    DIRAIGENT_API_URL=$API \\
    DIRAIGENT_API_TOKEN=\$KEY \\
    AGENT_ID=\$AGENT \\
    PROJECTS_PATH=\$PROJECTS_BASE \\
    MAX_WORKERS=1 \\
    cargo run -p diraigent-orchestra

Then watch the QA flow:
  - http://localhost:4280/work
  - http://localhost:4280/review
  - http://localhost:4280/quick/$TASK

Walkthrough: docs/usage/SETUP-AND-DEMO.md
EOF
