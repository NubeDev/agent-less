# Local Forgejo Instance

Local-only Forgejo + Actions runner for exercising the `/pipelines`
and `/integrations` surfaces. **Do not point at production data.**

## Quick start

```sh
make forgejo-up        # start Forgejo container + admin user
```

Forgejo: <http://localhost:3030> · Login `diraigent` / `diraigent`.

Then start a runner from `startup/docker-compose.yml` (it mounts the
shipped labels config so the runner can pick up jobs):

```sh
cd startup && docker compose up -d forgejo-runner
```

## Credentials

Secrets are **not** committed. On first start `make forgejo-up`
creates the admin user; you generate:

- a **PAT** from <http://localhost:3030/user/settings/applications>
  (used by `scripts/forgejo-ci-demo.sh` as `FORGEJO_TOKEN`).
- a **runner registration secret** from the site admin runners page,
  exported as `FORGEJO_RUNNER_SECRET` for compose.

Persist them in `.env.local` (gitignored):

```sh
export FORGEJO_TOKEN=...
export FORGEJO_RUNNER_SECRET=...
```

## Ports

| Service      | Port |
|--------------|------|
| Forgejo HTTP | 3030 |
| Forgejo SSH  | 2222 |

## Makefile targets

| Target              | Purpose                              |
|---------------------|--------------------------------------|
| `make forgejo-up`   | Start Forgejo, create admin user     |
| `make forgejo-down` | Stop + remove Forgejo container      |
| `make forgejo-logs` | Tail Forgejo container logs          |

## CI integration demo

Once the runner is up and `FORGEJO_TOKEN` is exported:

```sh
. /tmp/diraigent-demo/state.env
FORGEJO_TOKEN=$FORGEJO_TOKEN bash scripts/forgejo-ci-demo.sh
```

See [`../docs/usage/SETUP-AND-DEMO.md`](../docs/usage/SETUP-AND-DEMO.md)
§ 4.5 for the full walkthrough.

## Troubleshooting

- **Runner reports `with labels: []`** — the daemon was started
  without a config. The compose service mounts
  `startup/forgejo-runner-config.yaml`; if you ran the daemon by
  hand, pass `--config /etc/forgejo-runner/config.yaml`.
- **Forgejo logs `webhook can only call allowed HTTP servers`** —
  webhooks are blocked from calling `localhost`/`172.17.0.1`. The
  compose service sets `FORGEJO__webhook__ALLOWED_HOST_LIST=*`. If
  you provisioned Forgejo by hand, append
  `[webhook]\nALLOWED_HOST_LIST = *` to `/data/gitea/conf/app.ini`
  and restart.
- **`/pipelines` stays empty after a push** — Forgejo 11 does not
  emit `workflow_run` events. Call `POST /v1/{proj}/forgejo/sync`
  (the CI demo script does this automatically).
