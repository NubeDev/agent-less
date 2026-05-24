# Diraigent — local development Makefile
# Non-default ports to avoid conflicts:
#   Postgres: 5488  |  API: 3100  |  Web: 4280

.PHONY: readme
readme:
	@echo ""
	@echo "  Diraigent — local dev targets"
	@echo "  ─────────────────────────────────────────"
	@echo "  make start       — build + start full stack (PG + API + Web)"
	@echo "  make stop        — stop all services"
	@echo "  make start-api   — build + start PG + API only"
	@echo "  make start-web   — start Angular dev server only"
	@echo "  make db-up       — start Postgres on port 5488"
	@echo "  make db-down     — remove Postgres container"
	@echo "  make db-psql     — open psql shell"
	@echo "  make build       — cargo build + pnpm install"
	@echo "  make run-api     — start PG + run API"
	@echo "  make run-orchestra — run orchestra"
	@echo "  make migrate     — run sqlx migrations"
	@echo "  make test        — cargo test --workspace"
	@echo ""

PG_PORT     := 5488
PG_USER     := diraigent
PG_PASS     := diraigent
PG_DB       := diraigent
API_PORT    := 3100
WEB_PORT    := 4280
DATABASE_URL := postgres://$(PG_USER):$(PG_PASS)@localhost:$(PG_PORT)/$(PG_DB)

export DATABASE_URL
export DEV_USER_ID := 00000000-0000-0000-0000-000000000001
export HOST := 0.0.0.0
export PORT := $(API_PORT)
export CORS_ORIGINS := http://localhost:$(WEB_PORT)

# ── Postgres ────────────────────────────────────────────────────────

.PHONY: db-up db-down db-logs db-psql

db-up:
	@docker rm -f diraigent-pg 2>/dev/null || true
	docker run -d --name diraigent-pg \
		-e POSTGRES_USER=$(PG_USER) \
		-e POSTGRES_PASSWORD=$(PG_PASS) \
		-e POSTGRES_DB=$(PG_DB) \
		-p $(PG_PORT):5432 \
		postgres:18-alpine
	@echo "Waiting for Postgres on port $(PG_PORT)..."
	@until docker exec diraigent-pg pg_isready -U $(PG_USER) >/dev/null 2>&1; do sleep 0.3; done
	@echo "Postgres ready."

db-down:
	docker rm -f diraigent-pg

db-logs:
	docker logs -f diraigent-pg

db-psql:
	docker exec -it diraigent-pg psql -U $(PG_USER) -d $(PG_DB)

# ── Build ───────────────────────────────────────────────────────────

.PHONY: build build-api build-orchestra build-web

build: build-api build-web

build-api:
	cargo build -p diraigent-api

build-orchestra:
	cargo build -p diraigent-orchestra

build-web:
	cd apps/web && pnpm install --frozen-lockfile && pnpm ng build

# ── Run ─────────────────────────────────────────────────────────────

.PHONY: run-api run-web run-orchestra start start-api start-web stop restart

run-api: db-up
	cargo run -p diraigent-api

run-web:
	cd apps/web && pnpm ng serve --port $(WEB_PORT) --proxy-config proxy.conf.json

run-orchestra:
	cargo run -p diraigent-orchestra

# Full local stack: postgres + api (background) + web (foreground)
start: db-up build-api
	@echo "Starting API on http://localhost:$(API_PORT) ..."
	@cargo run -p diraigent-api &
	@sleep 2
	@echo "Starting Web on http://localhost:$(WEB_PORT) ..."
	@cd apps/web && [ -d node_modules ] || pnpm install --frozen-lockfile
	cd apps/web && pnpm ng serve --port $(WEB_PORT) --proxy-config proxy.conf.json

start-api: db-up
	@echo "Starting API on http://localhost:$(API_PORT) ..."
	cargo run -p diraigent-api

start-web:
	@echo "Starting Web on http://localhost:$(WEB_PORT) ..."
	cd apps/web && pnpm ng serve --port $(WEB_PORT)

stop:
	@-pkill -f "target/debug/diraigent-api" 2>/dev/null || true
	@-pkill -f "ng serve" 2>/dev/null || true
	@-fuser -k $(WEB_PORT)/tcp 2>/dev/null || true
	@-fuser -k $(API_PORT)/tcp 2>/dev/null || true
	@-docker rm -f diraigent-pg 2>/dev/null || true
	@echo "Stopped."

restart: stop start

# ── Misc ────────────────────────────────────────────────────────────

.PHONY: migrate test

migrate: db-up
	@echo "Running migrations via sqlx..."
	cargo sqlx migrate run --source apps/api/migrations

test:
	cargo test --workspace
