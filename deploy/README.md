# Deploy / dev stack

Backing services (CouchDB + Garage + Meilisearch + their admin UIs) and,
optionally, the app — one `docker-compose.yml`, driven by the **stack runner** so
it shares the repo-root `.env` with the host-run app.

## Run it (via the runner, not raw compose)

```bash
bun run scripts/stack.ts up              # backing services only (dev: run app on host)
bun run scripts/stack.ts up --app        # also run the app container (deploy)
bun run scripts/stack.ts up --upstream   # backing services from PUBLIC images (no mirror)
bun run scripts/stack.ts down|restart|logs|ps [--app] [--upstream]
# shortcuts: bun run stack:up | stack:up:upstream | stack:down | stack:restart | stack:logs
```

The runner passes the repo-root `.env` to docker compose — the **same** file Bun
auto-loads for the host-run `webapi`/`webui` — so ports, image refs, and secrets
are defined once and stay coherent. App config (DB/bucket names, feature flags)
lives in `config/`, baked into the app image **and** read by the host app.

> **Dev vs in-container endpoints:** on the host the app talks to
> `127.0.0.1:765x`; inside the compose network the `app` service talks to the
> service names (`couchdb:5984`, `garage:3900`, `meilisearch:7700`) — the compose
> file overrides those endpoints. Only the endpoints differ; config + secrets are
> shared.

## Images

Two ways to source the backing-service images:

1. **Mirror (default / deploy)** — pulled from the GitHub Container Registry
   (GHCR) namespace `${IMAGE_NS}` (e.g. `ghcr.io/OWNER`), pinned:
   `claude-transcripts-{couchdb,garage,garage-ui,meilisearch,meilisearch-ui,app}`.
   Mirror them once: `IMAGE_NS=ghcr.io/OWNER bun run scripts/mirror-images.ts`.
2. **Upstream (`--upstream`, zero-setup dev)** — pulls the canonical **public**
   images directly (`couchdb`, `dxflrs/garage`, `getmeili/meilisearch`, + community
   admin UIs), so a fresh clone runs with **no mirror and no `IMAGE_NS`**. This is
   the `deploy/docker-compose.upstream.yml` override, layered over the base file.

Both compose files are **generated from the app model** (`bun run gen:compose` +
`gen:compose-override`); the upstream image for each service is the `image.upstream`
field in `packages/shared/src/model/services.ts`. The app image is always built +
published by the `publish-image` workflow on a `vX.Y.Z` tag (no upstream).

## Ports (dev range `7650–7661`)

| Port | Service |
|------|---------|
| 7650 | webapi (host dev / app container) |
| 7651 | webui Vite dev server (host) |
| 7652 | CouchDB HTTP API + Fauxton (`/_utils/`) |
| 7653 | Garage S3 API |
| 7654 | Garage admin API |
| 7655 | Garage web UI |
| 7656 | Meilisearch (API + built-in UI) |
| 7657 | Meilisearch UI |

## State

Bind-mounted under `deploy/data/` (gitignored) — wipe it to reset the stack.

## No auth (localhost only) — ADR 0020

App access needs no tokens/keys/passwords; safe only because everything binds to
`127.0.0.1`. Garage still needs **internal** cluster secrets (`GARAGE_RPC_SECRET`,
`GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN` in `.env`; `openssl rand -hex 32`).

## One-time Garage bootstrap

Garage needs a layout, a bucket, and an app S3 key before first use (the S3
protocol always signs requests — "no auth" means we provide a default key, not
keyless). After `stack:up`:

1. Assign a node layout, create the `claude-transcripts-sessions` bucket, create a key,
   grant it access (a `setup` automation will wrap this; until then see the
   [Garage quick-start](https://garagehq.deuxfleurs.fr/documentation/quick-start/)).
2. Put the key into `.env` (`S3_ACCESS_KEY` / `S3_SECRET_KEY`).
