# Deploy / dev stack

> Running on **Kubernetes** (e.g. single-node k3s)? The same stack is generated as a
> kustomize base under [`k8s/`](k8s/README.md).

Backing services (CouchDB + Garage + Fossil + Meilisearch + their admin UIs) and,
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
   `claude-transcripts-{couchdb,garage,garage-ui,fossil,meilisearch,meilisearch-ui}`.
   Mirror them once: `IMAGE_NS=ghcr.io/OWNER bun run scripts/mirror-images.ts` —
   it also builds and pushes `claude-transcripts-fossil` (see [Fossil](#fossil)).
2. **Upstream (`--upstream`, zero-setup dev)** — pulls the canonical **public**
   images directly (`couchdb`, `dxflrs/garage`, `getmeili/meilisearch`, + community
   admin UIs), so a fresh clone runs with **no mirror and no `IMAGE_NS`**. This is
   the `deploy/docker-compose.upstream.yml` override, layered over the base file.
   Fossil has no public image, so this override **builds** it from
   `deploy/fossil/Dockerfile` instead (about a minute, first start only).

Both compose files are **generated from the app model** (`bun run gen:compose` +
`gen:compose-override`); the upstream image for each service is the `image.upstream`
field in `packages/shared/src/model/services.ts`. The app image is built + published
by the `publish-image` workflow (no upstream; tags in
[releasing.md](../docs/operate/releasing.md#app-image-tags)).

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
| 7658 | Fossil web UI + sync, one repo per path (`http://127.0.0.1:7658/<name>/`) |

## State

Bind-mounted under `deploy/data/` (gitignored) — wipe it to reset the stack.

## Fossil

[Fossil](https://fossil-scm.org) is version control whose single binary is also its
server: the web UI (timeline, files, wiki, tickets) and the HTTP endpoint `fossil
clone`/`sync` talk to. It is provisioned infrastructure only — nothing in the app uses
it yet ([ADR 0031](../docs/design/decisions/0031-fossil-as-bundled-infrastructure.md)).

- **Image** — Fossil publishes none, so `fossil/Dockerfile` builds one from the
  official release source (pinned tarball, sha256-checked, static binary on
  `scratch`). To upgrade, bump the three `ARG`s there and `defaultTag` in
  `packages/shared/src/model/services.ts`; a test fails if they disagree.
- **Repository** — the container serves every `*.fossil` file in `data/fossil/` at
  `/<name>/` and lists them at `/`. It creates none: the app's repository is named by
  `fossil.repositories` in `config/` (default `claude-transcripts-sessions`, like the
  database and bucket) and will be seeded by the app. Until then the list is empty;
  to create one by hand (no auth, like the rest of the stack — ADR 0020):

  ```bash
  F="docker exec claude-transcripts-fossil fossil"
  $F new --admin-user admin /museum/claude-transcripts-sessions.fossil
  $F user capabilities nobody s -R /museum/claude-transcripts-sessions.fossil
  ```
- **API** — built with Fossil's JSON API. The webapi reads it read-only at
  `/api/fossil/<repoKey>/json/...` (see [webapi.md](../docs/reference/webapi.md)).

## No credentials to supply (localhost only) — ADR 0020

You generate no tokens, keys, or passwords of your own; safe only because
everything binds to `127.0.0.1`. Two things ship with credentials rather than
without: Garage's pre-baked app key, and CouchDB's default admin
(`COUCHDB_USER`/`COUCHDB_PASSWORD`, defaulting to `admin`/`admin`) — CouchDB 3
removed "admin party" and will not start without an admin. Garage also needs
**internal** cluster secrets (`GARAGE_RPC_SECRET`,
`GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN` in `.env`; `openssl rand -hex 32`).

## One-time Garage bootstrap

Garage needs a layout, bucket and app key before first use. After `stack:up`, run
`bun run bootstrap:garage` (idempotent; writes `S3_ACCESS_KEY`/`S3_SECRET_KEY` into
`.env`). By hand: [README step 4](../README.md#4-one-time-garage-bootstrap-create-the-bucket--an-app-key).
