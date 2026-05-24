#!/usr/bin/env bash
# Throwaway local demo project for Diraigent.
#
# Provisions everything needed to watch the orchestra run a tiny real task
# against a local-only git repo. Talks to the local dev API at
# http://localhost:3100 (the `make start` Makefile flow).
#
# Idempotent-ish: blows away /tmp/diraigent-demo and recreates from scratch.
#
# Usage:
#   ./scripts/throwaway-demo.sh
#
# After it prints the orchestra command, run that in another terminal and
# watch the dashboard at http://localhost:4280.

set -euo pipefail

DEV="${DEV_USER_ID:-00000000-0000-0000-0000-000000000001}"
ROOT="${DIRAIGENT_API_URL_ROOT:-http://localhost:3100}"
API="$ROOT/v1"
PROJECTS_BASE="${PROJECTS_BASE:-/tmp/diraigent-demo}"
SLUG="${SLUG:-throwaway}"
# repo_url drives the on-disk path: $PROJECTS_BASE/<host>/<owner>/<slug>.
# Use a stable dummy host that lives only on disk; clones over the network
# will fail with NXDOMAIN, which the orchestra tolerates as long as the repo
# already exists at the derived path.
REPO_HOST="${REPO_HOST:-example.invalid}"
REPO_OWNER="${REPO_OWNER:-local}"
REPO_URL="https://$REPO_HOST/$REPO_OWNER/$SLUG.git"
DEMO="$PROJECTS_BASE/$REPO_HOST/$REPO_OWNER/$SLUG"
H_DEV=(-H "X-Dev-User-Id: $DEV" -H 'Content-Type: application/json')

die() { echo "error: $*" >&2; exit 1; }

# ── 0) Sanity-check API ──────────────────────────────────────────
curl -sf "$ROOT/health/live" >/dev/null \
  || die "API not reachable at $ROOT — run 'make start' first"

# ── 1) Local throwaway git repo ──────────────────────────────────
# Preserve state.env across runs (it holds the agent's api_key, which the API
# only returns once at creation).
PREV_STATE=""
if [ -f "$PROJECTS_BASE/state.env" ]; then
  PREV_STATE=$(mktemp)
  cp "$PROJECTS_BASE/state.env" "$PREV_STATE"
fi
echo "==> creating local repo at $DEMO"
rm -rf "$PROJECTS_BASE"
mkdir -p "$DEMO"
if [ -n "$PREV_STATE" ]; then
  cp "$PREV_STATE" "$PROJECTS_BASE/state.env"
  rm -f "$PREV_STATE"
fi
(
  cd "$DEMO"
  git init -q -b main
  git config user.email demo@local
  git config user.name  demo
  echo '# throwaway' > README.md
  cat > main.rs <<'RS'
fn main() {
    println!("hi");
}
RS
  # Drop in a multi-step playbook so the Job Theatre renders a real
  # pipeline (plan → implement → review) instead of a single node.
  mkdir -p .diraigent/playbooks
  cat > .diraigent/playbooks/demo.yaml <<'YAML'
title: Demo Lifecycle
trigger_description: "plan → implement → review"
initial_state: ready
tags: [demo]
metadata:
  git_strategy: merge_to_default
steps:
  - name: plan
    budget: 2.0
    allowed_tools: readonly
    context_level: minimal
    on_complete: next
    description: |
      ## Your Job: PLAN
      1. `{{agent_cli}} task {{task_id}}` — read the spec.
      2. `{{agent_cli}} claim {{task_id}}`
      3. Post a 3–5 bullet plan via `{{agent_cli}} artifact {{task_id}} "PLAN: …"`.
      4. `{{agent_cli}} transition {{task_id}} done`
      **Rules**: Do NOT write code. Do NOT modify files.
  - name: implement
    budget: 8.0
    allowed_tools: full
    context_level: full
    on_complete: next
    description: |
      ## Your Job: IMPLEMENT
      1. `{{agent_cli}} task {{task_id}}` — read the spec + the prior PLAN artifact.
      2. `{{agent_cli}} claim {{task_id}}`
      3. Implement the code as the spec + plan dictate.
      4. Run the task's `test_cmd` if set; iterate until green (max 3 retries).
      5. `{{agent_cli}} artifact {{task_id}} "test output"`
      6. `{{agent_cli}} transition {{task_id}} done`
      **Rules**: Do NOT run `git push`. Stay in your worktree.
  - name: review
    budget: 3.0
    allowed_tools: readonly
    context_level: minimal
    on_complete: next
    description: |
      ## Your Job: REVIEW
      1. `{{agent_cli}} task {{task_id}}`
      2. `{{agent_cli}} claim {{task_id}}`
      3. `git diff {{project.default_branch}}...HEAD` — inspect.
      4. Post `{{agent_cli}} artifact {{task_id}} "REVIEW: <findings>"`.
      5. APPROVED → `{{agent_cli}} transition {{task_id}} done`.
         CHANGES → `{{agent_cli}} blocker {{task_id}} "<what>"` then `transition ready`.
      **Rules**: Do NOT modify code. Cite file:line in findings.
YAML
  git add .
  git commit -q -m 'init'
)
echo "    $DEMO @ $(git -C "$DEMO" rev-parse --short HEAD)"

# ── 2) Project (idempotent: reuse if slug exists) ────────────────
# repo_url validator only accepts http/https/git@/ssh:// so we pass a dummy
# https URL. The orchestra provisioner treats an existing .git as cloned and
# only logs a fetch warning.
echo "==> project"
PROJ=$(curl -sf "$API/by-slug/$SLUG" "${H_DEV[@]}" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null \
  || true)
if [ -z "$PROJ" ]; then
  PROJ=$(curl -sf -X POST "$ROOT/v1" "${H_DEV[@]}" -d "{
    \"name\":\"$SLUG\",
    \"slug\":\"$SLUG\",
    \"description\":\"local throwaway demo\",
    \"repo_url\":\"$REPO_URL\",
    \"default_branch\":\"main\",
    \"git_mode\":\"standalone\",
    \"metadata\":{\"upload_logs\":true,\"store_diffs\":true}
  }" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "    project: $PROJ (created)"
else
  echo "    project: $PROJ (reused)"
fi

# ── 3) Role (idempotent by name) ─────────────────────────────────
ROLE_NAME="orchestra-demo"
echo "==> role"
ROLE=$(curl -sf "$API/roles" "${H_DEV[@]}" \
  | python3 -c "import sys,json
for r in json.load(sys.stdin):
    if r.get('name')=='$ROLE_NAME': print(r['id']); break")
if [ -z "$ROLE" ]; then
  ROLE=$(curl -sf -X POST "$API/roles" "${H_DEV[@]}" -d "{
    \"name\":\"$ROLE_NAME\",
    \"description\":\"local demo\",
    \"authorities\":[\"execute\",\"create\",\"delegate\",\"review\",\"decide\"]
  }" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "    role:    $ROLE (created)"
else
  echo "    role:    $ROLE (reused)"
fi

# ── 4) Agent (api_key returned once at creation) ─────────────────
# If we already have state.env with an agent + key, reuse them.
AGENT_NAME="orchestra-local"
echo "==> agent"
AGENT=""; KEY=""
if [ -f "$PROJECTS_BASE/state.env" ]; then
  PREV_AGENT=$(grep -E '^AGENT=' "$PROJECTS_BASE/state.env" | cut -d= -f2- || true)
  PREV_KEY=$(  grep -E '^KEY='   "$PROJECTS_BASE/state.env" | cut -d= -f2- || true)
  if [ -n "$PREV_AGENT" ] && [ -n "$PREV_KEY" ] \
     && curl -sf "$API/agents/$PREV_AGENT" "${H_DEV[@]}" >/dev/null 2>&1; then
    AGENT="$PREV_AGENT"; KEY="$PREV_KEY"
    echo "    agent:   $AGENT (reused from state.env)"
  fi
fi
if [ -z "$AGENT" ]; then
  # No reusable state — pick a unique agent name (API has no DELETE for agents,
  # so we can't reclaim a stale one whose api_key we've lost).
  AGENT_NAME_UNIQUE="$AGENT_NAME-$(date +%s)"
  AJSON=$(curl -sf -X POST "$API/agents" "${H_DEV[@]}" -d "{
    \"name\":\"$AGENT_NAME_UNIQUE\",
    \"kind\":\"claude\",
    \"capabilities\":[\"rust\"],
    \"metadata\":{\"runtime\":\"orchestra\"}
  }")
  AGENT=$(echo "$AJSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  KEY=$(  echo "$AJSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_key",""))')
  [ -n "$KEY" ] || die "agent created but no api_key returned"
  echo "    agent:   $AGENT (created as $AGENT_NAME_UNIQUE)"
fi
echo "    key:     ${KEY:0:14}..."

# ── 5) Membership (idempotent: 409 means already exists) ─────────
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/members" "${H_DEV[@]}" \
  -d "{\"agent_id\":\"$AGENT\",\"role_id\":\"$ROLE\"}")
case "$HTTP" in
  200|201|204) echo "    membership: ok (created)" ;;
  409)         echo "    membership: ok (exists)" ;;
  *)           die "membership create returned HTTP $HTTP" ;;
esac

# ── 6) Demo task → ready ─────────────────────────────────────────
echo "==> creating demo task"
TASK=$(curl -sf -X POST "$API/$PROJ/tasks" "${H_DEV[@]}" -d '{
  "title":"Add a greet() function",
  "kind":"feature",
  "playbook_name":"demo",
  "context":{
    "spec":"Add fn greet(name: &str) -> String to main.rs that returns \"Hello, <name>!\". Call it from main with name = \"world\".",
    "files":["main.rs"],
    "test_cmd":"rustc main.rs -o /tmp/throwaway-bin && /tmp/throwaway-bin",
    "acceptance_criteria":["main.rs defines fn greet","running the binary prints Hello, world!"]
  }
}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -sf -X POST "$API/tasks/$TASK/transition" "${H_DEV[@]}" \
  -d '{"state":"ready"}' >/dev/null
echo "    task:    $TASK (ready)"

# ── 7) Persist state ─────────────────────────────────────────────
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

# ── 8) Print the command to start the orchestra ──────────────────
cat <<EOF

==> Demo ready. Start the orchestra in another terminal:

    . $PROJECTS_BASE/state.env
    cd $(pwd)
    DIRAIGENT_API_URL=$API \\
    DIRAIGENT_API_TOKEN=\$KEY \\
    AGENT_ID=\$AGENT \\
    PROJECTS_PATH=\$PROJECTS_BASE \\
    MAX_WORKERS=1 \\
    cargo run -p diraigent-orchestra

Dashboard: http://localhost:4280
EOF
