#!/usr/bin/env bash
# Forgejo CI integration demo — extends scripts/web-demo.sh.
#
# Prereqs:
#   - make start (Diraigent API on :3100, Web on :4280, PG on :5488)
#   - Forgejo running on :3030 with a registered runner
#   - scripts/web-demo.sh already executed (gives us $PROJ + repo on disk)
#   - env: FORGEJO_TOKEN (diraigent user PAT)
#
# What it does:
#   1. Creates a Forgejo repo `diraigent/web-demo`.
#   2. Adds .forgejo/workflows/ci.yml to the demo repo and pushes to Forgejo.
#   3. Registers the Forgejo integration in Diraigent via the same endpoint the
#      /pipelines/forgejo-setup UI uses (POST /v1/{proj}/integrations/forgejo).
#   4. Rewrites the webhook URL to the docker-bridge IP so the Forgejo
#      container can reach the host's API on :3100. Configures the webhook
#      on the Forgejo repo via API.
#   5. Pushes an empty commit to trigger the runner; tails the run.
#
# Result:
#   - /integrations in the Diraigent UI shows the Forgejo integration.
#   - /pipelines shows the CI run as it executes.
#   - /pipelines/{runId} shows job + step detail synced via webhook.

set -euo pipefail

# ── 0) Config ────────────────────────────────────────────────────
DEV_USER_ID="${DEV_USER_ID:-00000000-0000-0000-0000-000000000001}"
DIRAIGENT_API="${DIRAIGENT_API:-http://localhost:3100/v1}"
FORGEJO_URL="${FORGEJO_URL:-http://localhost:3030}"
FORGEJO_USER="${FORGEJO_USER:-diraigent}"
FORGEJO_PASS="${FORGEJO_PASS:-diraigent}"
FORGEJO_TOKEN="${FORGEJO_TOKEN:?set FORGEJO_TOKEN (Forgejo PAT for $FORGEJO_USER)}"
REPO_NAME="${REPO_NAME:-web-demo}"
STATE_FILE="${STATE_FILE:-/tmp/diraigent-demo/state.env}"

# Forgejo container can reach the host on this IP (docker bridge default).
HOST_FROM_CONTAINER="${HOST_FROM_CONTAINER:-172.17.0.1}"

[[ -f "$STATE_FILE" ]] || { echo "missing $STATE_FILE — run scripts/web-demo.sh first" >&2; exit 1; }
# shellcheck disable=SC1090
. "$STATE_FILE"
[[ -n "${PROJ:-}" && -n "${DEMO:-}" ]] || { echo "PROJ/DEMO not set in $STATE_FILE" >&2; exit 1; }

H_DIRA=(-H "X-Dev-User-Id: $DEV_USER_ID" -H 'Content-Type: application/json')
H_FORG=(-H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json')

die() { echo "error: $*" >&2; exit 1; }

# ── 1) Sanity ────────────────────────────────────────────────────
curl -sf "$DIRAIGENT_API/../health/live" >/dev/null || die "Diraigent API down"
curl -sf "$FORGEJO_URL/api/v1/version" >/dev/null || die "Forgejo down at $FORGEJO_URL"

ME=$(curl -sf "${H_FORG[@]}" "$FORGEJO_URL/api/v1/user" | python3 -c 'import sys,json;print(json.load(sys.stdin)["login"])')
echo "==> Forgejo user: $ME"

# ── 2) Create (or reuse) Forgejo repo ────────────────────────────
echo "==> Forgejo repo $ME/$REPO_NAME"
EXISTS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${H_FORG[@]}" "$FORGEJO_URL/api/v1/repos/$ME/$REPO_NAME")
if [[ "$EXISTS_CODE" == "200" ]]; then
  echo "    reused (HTTP 200)"
else
  curl -sf -X POST "${H_FORG[@]}" "$FORGEJO_URL/api/v1/user/repos" \
    -d "{\"name\":\"$REPO_NAME\",\"description\":\"Diraigent web-demo\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" \
    >/dev/null
  echo "    created"
fi

REPO_HTTP_URL="$FORGEJO_URL/$ME/$REPO_NAME"
REPO_PUSH_URL="http://$FORGEJO_USER:$FORGEJO_TOKEN@${FORGEJO_URL#http://}/$ME/$REPO_NAME.git"

# ── 3) Add CI workflow + push ────────────────────────────────────
echo "==> seeding .forgejo/workflows/ci.yml"
mkdir -p "$DEMO/.forgejo/workflows"
cat > "$DEMO/.forgejo/workflows/ci.yml" <<'YAML'
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: docker
    container:
      image: rust:1.83-slim
    steps:
      - name: checkout
        uses: actions/checkout@v4
      - name: cargo --version
        run: cargo --version
      - name: cargo check
        run: cargo check --manifest-path Cargo.toml || echo "(no src/main.rs yet — that's the agent's job)"
      - name: list workspace
        run: ls -la && cat Cargo.toml
YAML

(
  cd "$DEMO"
  git add -A
  if git diff --cached --quiet; then
    echo "    workflow unchanged"
  else
    git -c user.email=demo@local -c user.name=demo commit -q -m "ci: add forgejo workflow"
  fi
  git remote remove forgejo 2>/dev/null || true
  git remote add forgejo "$REPO_PUSH_URL"
  echo "==> push to Forgejo"
  git push -q forgejo main:main --force
  echo "    pushed"
)

# ── 4) Register Forgejo integration in Diraigent ─────────────────
echo "==> Diraigent integration"
INT_JSON=$(mktemp)
RESP=$(mktemp)
HOOK_JSON=$(mktemp)
trap 'rm -f "$INT_JSON" "$RESP" "$HOOK_JSON"' EXIT

if [[ -n "${FORGEJO_INTEGRATION_ID:-}" && -n "${FORGEJO_WEBHOOK_SECRET:-}" ]]; then
  INTEGRATION_ID="$FORGEJO_INTEGRATION_ID"
  WEBHOOK_SECRET="$FORGEJO_WEBHOOK_SECRET"
  echo "    reused integration $INTEGRATION_ID (from state.env)"
else
  # base_url per the UI hint is the repo URL.
  cat > "$INT_JSON" <<EOF
{
  "base_url": "$REPO_HTTP_URL",
  "token": "$FORGEJO_TOKEN"
}
EOF
  CODE=$(curl -s -o "$RESP" -w '%{http_code}' -X POST "${H_DIRA[@]}" \
    "$DIRAIGENT_API/$PROJ/integrations/forgejo" --data-binary "@$INT_JSON")
  if [[ "$CODE" != 2* ]]; then
    cat "$RESP" >&2
    die "registerForgejo HTTP $CODE"
  fi
  INTEGRATION_ID=$(python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' < "$RESP")
  WEBHOOK_SECRET=$(python3 -c 'import sys,json;print(json.load(sys.stdin)["webhook_secret"])' < "$RESP")
  echo "    created integration $INTEGRATION_ID"
fi

# Rewrite webhook URL to be reachable from the Forgejo container.
WEBHOOK_URL="http://$HOST_FROM_CONTAINER:3100/v1/webhooks/forgejo/$INTEGRATION_ID"
echo "    webhook URL (reachable from container): $WEBHOOK_URL"

# ── 5) Add webhook on the Forgejo repo ───────────────────────────
echo "==> Forgejo webhook"
cat > "$HOOK_JSON" <<EOF
{
  "type": "forgejo",
  "active": true,
  "events": ["push","pull_request","workflow_run","workflow_job"],
  "config": {
    "url": "$WEBHOOK_URL",
    "content_type": "json",
    "secret": "$WEBHOOK_SECRET"
  }
}
EOF
# Remove any prior webhook pointing at us.
EXISTING=$(curl -sf "${H_FORG[@]}" "$FORGEJO_URL/api/v1/repos/$ME/$REPO_NAME/hooks" \
  | python3 -c "import sys,json;
hooks = json.load(sys.stdin)
for h in hooks:
  if 'webhooks/forgejo' in h.get('config',{}).get('url',''):
    print(h['id'])")
for hid in $EXISTING; do
  curl -sf -X DELETE "${H_FORG[@]}" "$FORGEJO_URL/api/v1/repos/$ME/$REPO_NAME/hooks/$hid" || true
  echo "    removed stale webhook $hid"
done
curl -sf -X POST "${H_FORG[@]}" "$FORGEJO_URL/api/v1/repos/$ME/$REPO_NAME/hooks" \
  --data-binary "@$HOOK_JSON" >/dev/null
echo "    webhook configured"

# ── 6) Trigger CI with an empty commit ───────────────────────────
echo "==> trigger CI"
(
  cd "$DEMO"
  git -c user.email=demo@local -c user.name=demo commit --allow-empty -q \
    -m "trigger: $(date +%FT%T)"
  git push -q forgejo main:main
)
echo "    push sent — runner will pick it up shortly"

# Give the runner a head-start before pulling status. The catthehacker
# image pull can take 30-60s on first run.
WAIT="${WAIT_SECS:-25}"
echo "==> waiting ${WAIT}s for runner, then syncing"
sleep "$WAIT"

# ── 6b) Pull workflow runs into Diraigent ────────────────────────
# Forgejo 11 push-webhooks deliver immediately (verifiable in API logs) but
# this version does not emit workflow_run / workflow_job events that the
# Diraigent webhook receiver routes on. The forgejo/sync endpoint polls
# Forgejo's REST API and upserts ci_run rows directly, so /pipelines lights
# up regardless of webhook event support.
SYNC=$(curl -s -X POST "${H_DIRA[@]}" "$DIRAIGENT_API/$PROJ/forgejo/sync")
echo "    sync: $SYNC"

# ── 7) Persist state additions ───────────────────────────────────
{
  grep -v '^FORGEJO_' "$STATE_FILE" || true
  echo "FORGEJO_REPO=$ME/$REPO_NAME"
  echo "FORGEJO_INTEGRATION_ID=$INTEGRATION_ID"
  echo "FORGEJO_WEBHOOK_SECRET=$WEBHOOK_SECRET"
  echo "FORGEJO_WEBHOOK_URL=$WEBHOOK_URL"
} > "$STATE_FILE.new"
mv "$STATE_FILE.new" "$STATE_FILE"
echo "    state saved"

cat <<EOF

==> Done. Watch CI populate in real time:

    Forgejo run page:
      $REPO_HTTP_URL/actions
    Diraigent /pipelines:
      http://localhost:4280/pipelines
    Diraigent /integrations:
      http://localhost:4280/integrations

If /pipelines stays empty after a few seconds, check the webhook delivery:
    curl -sf -H "Authorization: token \$FORGEJO_TOKEN" \\
      $FORGEJO_URL/api/v1/repos/$ME/$REPO_NAME/hooks \\
      | python3 -m json.tool

And tail the API log for /v1/webhooks/forgejo/$INTEGRATION_ID POSTs.
EOF
