#!/usr/bin/env bash
# Seed the "Job Theatre" long-term goal into the running diraigent dev system.
# Creates: 1 project pointing at this repo + 1 parent task ("epic") +
# 4 child tasks (MVP -> Live -> Files -> Timeline), each configured to
# yolo AI-auto-resolve every QA item (no human gate).
#
# Prereqs: diraigent-api running on :3100 with DEV_USER_ID set.
# Run:     bash scripts/seed-job-theatre.sh
# Re-run:  safe-ish; will create a fresh project with a timestamped slug.

set -euo pipefail

API="${DIRAIGENT_API:-http://localhost:3100}"
DEV_USER="${DEV_USER_ID:-00000000-0000-0000-0000-000000000001}"
REPO_PATH="${REPO_PATH:-$(pwd)}"
PLAYBOOK="${PLAYBOOK:-standard}"

H_USER=(-H "X-Dev-User-Id: ${DEV_USER}")
H_JSON=(-H "Content-Type: application/json")

# Yolo QA: AI responds, always-ai accept (no confidence gate), even
# on irreversible steps. The orchestra still upgrades to second_pass
# when accept=="confidence" + irreversible; AlwaysAi is preserved.
YOLO_QA='{
  "responder":"ai",
  "accept":"always_ai",
  "min_confidence":0.0,
  "on_irreversible":"ai",
  "expires_at_secs":900
}'

require() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
require curl
require jq

post() {
  # $1 = path, $2 = json
  curl -fsS -X POST "${API}$1" "${H_USER[@]}" "${H_JSON[@]}" -d "$2"
}

# --- 1. Project ----------------------------------------------------------
SLUG="diraigent-self-$(date +%Y%m%d-%H%M%S)"
# Project must reference a relative repo path under PROJECTS_PATH.
# The orchestra is launched with PROJECTS_PATH=/home/user/code/rust, so
# git_root='diraigent' resolves to /home/user/code/rust/diraigent (this repo).
GIT_ROOT_REL="${GIT_ROOT_REL:-diraigent}"
PROJECT_PAYLOAD=$(jq -n \
  --arg name "Diraigent (self)" \
  --arg slug "${SLUG}" \
  --arg desc "Use diraigent to build diraigent's Job Theatre UI. Repo: ${REPO_PATH}" \
  --arg root "${GIT_ROOT_REL}" \
  '{name:$name, slug:$slug, description:$desc,
    default_branch:"main", git_mode:"standalone", git_root:$root,
    package_slug:"software-dev"}')

echo "==> creating project (slug=${SLUG}, repo=${REPO_PATH})"
PROJECT=$(post /v1/projects "${PROJECT_PAYLOAD}")
PROJECT_ID=$(echo "${PROJECT}" | jq -r .id)
echo "    project_id=${PROJECT_ID}"

# --- 2. Parent task ("epic") --------------------------------------------
# Long-term-goal description lives in context.epic_brief so child tasks
# inherit it via the related-items API.
EPIC_BRIEF=$(cat <<'MD'
# Long-term goal — Job Theatre UI

Today a user cannot follow a single job (task) through its whole life:
state is spread across /tasks, /qa, /reports, and the audit log. The
docs/diraigent-core-architecture.html sketch is static. We need ONE
interactive page per job that shows the full lifecycle as a live DAG,
with a quick-view drawer that answers "what prompt did we send", "what
files did this step write", "what QA fired", and "what was the audit
trail" — all from one selection model.

Library: ngx-graph (dagre-style Angular DAG) + Monaco for diff.
Route: /jobs/:taskId.

Acceptance for the long-term goal:
- Operator opens /jobs/:taskId and sees a DAG of every step + QA
  + verify + merge node for that task, status-coloured.
- Clicking any node updates a right-side drawer with tabs:
  Overview | Prompt | Output | Files | Logs | Audit | QA.
- Files tab shows a per-step Monaco diff vs the prior step.
- Live updates via SSE; finished jobs replay via timeline scrub.

Decomposed into 4 sequential tasks below.
MD
)

PARENT_CTX=$(jq -n --arg brief "${EPIC_BRIEF}" \
  --argjson qa "${YOLO_QA}" \
  '{epic_brief:$brief, qa_override:$qa}')

# Epic is a container, not work. Omit playbook_name so it stays in
# 'backlog' state and the orchestra won't claim it.
PARENT_PAYLOAD=$(jq -n \
  --arg title "EPIC: Job Theatre — one page per job, full lifecycle" \
  --argjson ctx "${PARENT_CTX}" \
  '{title:$title, kind:"feature", context:$ctx}')

echo "==> creating parent (epic) task"
PARENT=$(post "/v1/${PROJECT_ID}/tasks" "${PARENT_PAYLOAD}")
PARENT_ID=$(echo "${PARENT}" | jq -r .id)
echo "    parent_id=${PARENT_ID}"

# --- 3. Child tasks ------------------------------------------------------
create_child() {
  local title="$1" brief="$2" scope_json="$3"
  local ctx
  ctx=$(jq -n \
    --arg brief "${brief}" \
    --argjson qa "${YOLO_QA}" \
    --argjson scope "${scope_json}" \
    '{spec:$brief, qa_override:$qa, file_scope_hint:$scope}')
  local payload
  payload=$(jq -n \
    --arg title "${title}" \
    --arg pb "${PLAYBOOK}" \
    --arg parent "${PARENT_ID}" \
    --argjson ctx "${ctx}" \
    --argjson scope "${scope_json}" \
    '{title:$title, kind:"feature", playbook_name:$pb,
      parent_id:$parent, context:$ctx, file_scope:$scope}')
  local resp
  resp=$(post "/v1/${PROJECT_ID}/tasks" "${payload}")
  echo "$(echo "${resp}" | jq -r .id)  ${title}"
}

echo "==> creating child tasks"

C1_BRIEF=$(cat <<'MD'
## MVP — post-mortem Job Theatre view

Render the lifecycle of a FINISHED task as a static DAG. No live, no
diff, no scrub.

Route: /jobs/:taskId  (new feature module under apps/web/src/app/features/jobs)

Data sources (all already in the API):
- GET /v1/tasks/{id}                    -> root node
- GET /v1/tasks/{id}/work               -> step ordering
- GET /v1/tasks/{id}/qa or /v1/qa?task_id=  -> qa nodes
- GET /v1/projects/{p}/reports?task_id= -> report nodes
- GET /v1/audit?entity_id={id}          -> audit trail (drawer)

Library: ngx-graph (`@swimlane/ngx-graph`). Install via pnpm.
Layout: dagre, LR.

Drawer tabs to ship in MVP:
- Overview (status, duration, cost, agent, provider)
- Prompt   (raw rendered prompt for the selected step)
- Output   (raw provider response + extracted sentinel blocks)
- Logs     (task_log slice for the step)
- Audit    (audit_log entries for the entity)

Tabs deferred to later tasks: Files, QA-thread.

Acceptance:
- /jobs/{taskId} renders for any completed task in the seeded
  "web-demo" project.
- Clicking each node populates the drawer; tab switches are instant.
- E2E test under apps/web/e2e covers: open page, see DAG, click step,
  see prompt.

Out of scope: live updates, file diffs, timeline scrubbing.
MD
)

C2_BRIEF=$(cat <<'MD'
## Live updates via SSE

Make the MVP DAG transition in place as a job runs.

Backend:
- Reuse existing SSE infrastructure (see apps/api/src/routes/sse.rs).
  Add a per-task event stream or subscribe to the existing event bus
  filtered by entity_id.

Frontend:
- Subscribe in apps/web/src/app/features/jobs on init; unsubscribe
  on destroy. Node statuses transition: pending -> running -> done /
  failed / qa-parked. Animate a pulse on the running node.

Acceptance:
- Open /jobs/{taskId} on a task that is currently RUNNING.
- A node flips colour within 2s of the corresponding state change.
- No layout reflow on update (preserve dagre positions).

Depends on MVP task.
MD
)

C3_BRIEF=$(cat <<'MD'
## Files tab + per-step diff

Answer "who wrote this dir?" — clicking a file in the Files tab shows
which step authored each line.

Backend:
- Per-step snapshot: either persist a git tree-ish per step exit in a
  new `task_step_snapshot` table, OR derive on demand from the
  worktree using `git diff <prev-step-sha>..<this-step-sha>`.
  Pick the cheaper option; document trade-off in the task.

Frontend:
- Files tab lists changed paths per step (status M / A / D / R).
- Clicking a path opens a Monaco inline diff overlay (drawer
  expands to ~70% width).
- Optional: per-line "blame" colouring keyed to the step that wrote
  it (defer if too costly for MVP+2).

Acceptance:
- For a finished task, every step node has a populated Files tab.
- Diff renders within 500ms for files < 5k lines.

Depends on MVP task.
MD
)

C4_BRIEF=$(cat <<'MD'
## Timeline scrub + replay

Bottom strip showing the timeline of the job; dragging the playhead
re-renders the DAG to its state at that moment.

Frontend only (data already exists in audit_log + task_log timestamps).

Acceptance:
- Scrub bar at the bottom of /jobs/{taskId}.
- Dragging playhead left rewinds node statuses to what they were at
  that timestamp.
- Pressing "Replay" plays the scrub forward at 4x real-time.

Depends on MVP + Live tasks.
MD
)

C1_LINE=$(create_child "Job Theatre — MVP post-mortem view"        "${C1_BRIEF}" '["apps/web/src/app/features/jobs/**","apps/web/package.json"]')
C2_LINE=$(create_child "Job Theatre — Live SSE updates"            "${C2_BRIEF}" '["apps/web/src/app/features/jobs/**","apps/api/src/routes/sse.rs"]')
C3_LINE=$(create_child "Job Theatre — Files tab + Monaco diff"     "${C3_BRIEF}" '["apps/web/src/app/features/jobs/**","apps/api/src/routes/files.rs","apps/api/migrations/**"]')
C4_LINE=$(create_child "Job Theatre — Timeline scrub + replay"     "${C4_BRIEF}" '["apps/web/src/app/features/jobs/**"]')

C1_ID="${C1_LINE%% *}"; C2_ID="${C2_LINE%% *}"
C3_ID="${C3_LINE%% *}"; C4_ID="${C4_LINE%% *}"

echo
echo "==> child tasks:"
printf '%s\n%s\n%s\n%s\n' "${C1_LINE}" "${C2_LINE}" "${C3_LINE}" "${C4_LINE}"

# --- 3b. Dependencies: MVP -> Live -> (Files || Timeline) ---------------
echo "==> wiring dependencies"
add_dep() { post "/v1/tasks/$1/dependencies" "$(jq -n --arg d "$2" '{depends_on:$d}')" >/dev/null; }
add_dep "${C2_ID}" "${C1_ID}"   # Live  depends on MVP
add_dep "${C3_ID}" "${C2_ID}"   # Files depends on Live
add_dep "${C4_ID}" "${C2_ID}"   # Timeline depends on Live

# --- 4. Summary ----------------------------------------------------------
cat <<EOF

------------------------------------------------------------------
DONE.

Project:  ${SLUG}    ${PROJECT_ID}
Parent:   ${PARENT_ID}    (epic, contains long-term goal brief)

Open in UI:   http://localhost:4280/projects/${PROJECT_ID}
Tasks API:    ${API}/v1/${PROJECT_ID}/tasks

Next steps:
  1. Make sure the orchestra is pointing at this project so it
     picks up ready tasks. The new project needs orchestra-sync
     for playbook resolution.
  2. Each task carries context.qa_override = AlwaysAi yolo, so any
     QA the agent emits will be auto-resolved by an AI responder
     with no human gate (except runtime safety upgrades for merges).
  3. Watch:  curl -s -H "X-Dev-User-Id: ${DEV_USER}" \\
                ${API}/v1/${PROJECT_ID}/tasks | jq '.data[].state'

To delete this project later:
  curl -X DELETE -H "X-Dev-User-Id: ${DEV_USER}" \\
       ${API}/v1/projects/${PROJECT_ID}
EOF
