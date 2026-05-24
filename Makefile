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

.PHONY: db-up db-down db-logs db-psql db-reset clean

db-up:
	@if [ "$$(docker inspect -f '{{.State.Running}}' diraigent-pg 2>/dev/null)" = "true" ]; then \
		echo "Postgres already running."; exit 0; \
	fi
	@docker rm -f diraigent-pg 2>/dev/null || true
	docker volume create diraigent-pgdata 2>/dev/null || true
	# Mount at /var/lib/postgresql (NOT /data). postgres:18+ images place the
	# cluster in a major-version subdir under that path; mounting /data leaves
	# the image's expected dir empty and the container refuses to start. See
	# https://github.com/docker-library/postgres/issues/37 and PR #1259.
	docker run -d --name diraigent-pg \
		-e POSTGRES_USER=$(PG_USER) \
		-e POSTGRES_PASSWORD=$(PG_PASS) \
		-e POSTGRES_DB=$(PG_DB) \
		-v diraigent-pgdata:/var/lib/postgresql \
		-p $(PG_PORT):5432 \
		postgres:18-alpine
	@echo "Waiting for Postgres on port $(PG_PORT)..."
	@until docker exec diraigent-pg pg_isready -U $(PG_USER) >/dev/null 2>&1; do sleep 0.3; done
	@echo "Postgres ready."

db-down:
	docker rm -f diraigent-pg

db-reset: stop
	docker rm -f diraigent-pg 2>/dev/null || true
	docker volume rm diraigent-pgdata 2>/dev/null || true
	@echo "DB wiped. Run 'make start' to start fresh."

clean: db-reset db-up
	@echo "Fresh DB ready on port $(PG_PORT)."

db-logs:
	docker logs -f diraigent-pg

db-psql:
	docker exec -it diraigent-pg psql -U $(PG_USER) -d $(PG_DB)

# ── Forgejo ──────────────────────────────────────────────────────────

FORGEJO_PORT := 3030

.PHONY: forgejo-up forgejo-down forgejo-logs

forgejo-up:
	@if [ "$$(docker inspect -f '{{.State.Running}}' diraigent-forgejo 2>/dev/null)" = "true" ]; then \
		echo "Forgejo already running on http://localhost:$(FORGEJO_PORT)"; exit 0; \
	fi
	@docker rm -f diraigent-forgejo 2>/dev/null || true
	docker volume create diraigent-forgejo-data 2>/dev/null || true
	docker run -d --name diraigent-forgejo \
		-e FORGEJO__database__DB_TYPE=sqlite3 \
		-e FORGEJO__database__PATH=/data/gitea/forgejo.db \
		-e FORGEJO__server__ROOT_URL=http://localhost:$(FORGEJO_PORT)/ \
		-e FORGEJO__server__HTTP_PORT=3000 \
		-e FORGEJO__server__DOMAIN=localhost \
		-e FORGEJO__service__DISABLE_REGISTRATION=false \
		-e FORGEJO__actions__ENABLED=true \
		-e FORGEJO__security__INSTALL_LOCK=true \
		-v diraigent-forgejo-data:/data \
		-p $(FORGEJO_PORT):3000 \
		-p 2222:22 \
		codeberg.org/forgejo/forgejo:11
	@echo "Waiting for Forgejo..."
	@sleep 5
	@docker exec --user git diraigent-forgejo forgejo admin user create \
		--admin --username diraigent --password diraigent \
		--email admin@localhost --must-change-password=false \
		--config /data/gitea/conf/app.ini 2>/dev/null || true
	@echo "Forgejo ready: http://localhost:$(FORGEJO_PORT)"
	@echo "  Login: diraigent / diraigent"

forgejo-down:
	docker rm -f diraigent-forgejo

forgejo-logs:
	docker logs -f diraigent-forgejo

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
	@-docker stop diraigent-pg 2>/dev/null || true
	@echo "Stopped."

restart: stop start

# ── Misc ────────────────────────────────────────────────────────────

.PHONY: migrate test

migrate: db-up
	@echo "Running migrations via sqlx..."
	cargo sqlx migrate run --source apps/api/migrations

test:
	cargo test --workspace
