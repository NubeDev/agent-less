# Local Development

This is the **Linux-friendly** local dev flow. The `startup/start.sh` script in the
repo root reads Claude Code credentials from the macOS Keychain and is **macOS-only**;
use the Makefile flow below on Linux.

## Prerequisites

- Rust toolchain (`rustup`)
- Docker (for Postgres)
- `pnpm` (for the web app)
- `claude` CLI logged in (`claude login`) if you want to run the orchestra end-to-end

## Ports

Non-default ports are used to avoid clashes with anything you already have running:

| Service  | Port |
|----------|------|
| Postgres | 5488 |
| API      | 3100 |
| Web      | 4280 |

## Quick Start

```bash
# Start Postgres (5488) + API (3100) + Web (4280)
make start
```

- API:     <http://localhost:3100>
- Web UI:  <http://localhost:4280>
- Swagger: <http://localhost:3100/swagger-ui/>

Dev mode is enabled by default — no auth required. Requests are authenticated via
`DEV_USER_ID` (env var) or the `X-Dev-User-Id` header.

## Makefile Targets

| Target | Description |
|--------|-------------|
| `make start` | Start full stack (PG + API + Web) |
| `make stop` | Stop API, Web, and PG container |
| `make restart` | `stop` then `start` |
| `make start-api` | Start PG + API only |
| `make start-web` | Start Angular dev server only |
| `make db-up` | Start Postgres on port 5488 |
| `make db-down` | Remove Postgres container |
| `make db-psql` | Open psql shell |
| `make db-logs` | Tail Postgres logs |
| `make build` | `cargo build` API + `pnpm install` + `pnpm ng build` |
| `make run-api` | Start PG + run API (cargo run) |
| `make run-orchestra` | Run the orchestra |
| `make migrate` | Run sqlx migrations |
| `make test` | `cargo test --workspace` |

## Environment

Set in the Makefile — override as needed:

```
DATABASE_URL=postgres://diraigent:diraigent@localhost:5488/diraigent
DEV_USER_ID=00000000-0000-0000-0000-000000000001
HOST=0.0.0.0
PORT=3100
CORS_ORIGINS=http://localhost:4280
```

## Postgres

Runs in Docker on port **5488** (not the default 5432) to avoid conflicts:

```bash
make db-up    # start
make db-psql  # connect
make db-down  # destroy
```

## Throwaway demo project

To exercise the full pipeline (project → role → agent → task → orchestra picks
it up) against a real local git repo, run:

```bash
scripts/throwaway-demo.sh
```

This creates a tiny git repo at `/tmp/diraigent-demo/throwaway`, registers a
project, role, agent + API key, membership, and one `ready` task. It prints the
exact command to start the orchestra against that setup.

## API endpoint quirks

- Projects live at the root of `/v1`, **not** `/v1/projects`:
  - `GET  /v1`          → list projects
  - `POST /v1`          → create project
  - `GET  /v1/{id}`     → get project
  - `/v1/projects/{id}/...` is reserved for sub-resources (playbooks, etc.)
- `repo_url` validator only accepts `https://`, `http://`, `git@`, or `ssh://`.
  For purely-local repos pass a dummy `https://example.invalid/<slug>.git` and
  pre-place the repo at `$PROJECTS_PATH/<slug>` — the orchestra provisioner
  treats an existing `.git` as already-cloned.
- The task transition body uses `{ "state": "..." }`, not `to_state`.

## Swagger / API Docs

<http://localhost:3100/swagger-ui/>
