# Omnibus image

`claude-transcripts-omnibus` is the whole stack in one container: CouchDB, Garage and
its web UI, Meilisearch and its UI, Fossil, and the app (webapi, webui, docs), under
[s6-overlay](https://github.com/just-containers/s6-overlay). One `docker run`, one
volume, and only the webapi's port needs publishing.

It is a distribution format for a single Docker host (a home server, Unraid,
Synology), not the reference architecture. The [Compose stack](containers.md) and the
[Kubernetes base](../../deploy/k8s/README.md) run one container per service and remain
the way to run it properly. What you give up is listed under
[trade-offs](#trade-offs).

## Run it

```bash
bun run omnibus:build                    # from a checkout: app + Fossil images, then the omnibus
docker run -d --name claude-transcripts \
  -p 127.0.0.1:7650:7650 -v ct-omnibus:/data \
  claude-transcripts-omnibus:local
```

Then open `http://127.0.0.1:7650/app/`. First boot takes a minute or so while CouchDB
starts and Garage gets its layout; `docker ps` shows `healthy` when it's done.

## What's in it

| Port | Service | Notes |
|------|---------|-------|
| 7650 | webapi | API, webui at `/app`, docs at `/docs`, downloads at `/downloads/`. The one `EXPOSE`d port |
| 7652 | CouchDB | Fauxton at `/_utils/` |
| 7653 | Garage S3 API | |
| 7654 | Garage admin API | |
| 7655 | Garage web UI | |
| 7656 | Meilisearch | development mode, so its built-in dashboard is on |
| 7657 | Meilisearch UI | |
| 7658 | Fossil | web UI and sync, one repository per path |

The ports are the dev stack's, projected from the blueprint at boot, so the webui's
service links and the CLI's defaults point at the right places. Every service listens
on all interfaces inside the container; which ports reach the host is the runner's
choice. Publish the ones you want:

```bash
docker run -d -p 127.0.0.1:7650-7658:7650-7658 -v ct-omnibus:/data claude-transcripts-omnibus:local
```

Also inside:

- **The CLI**, on `PATH`: `docker exec -it claude-transcripts claude-transcripts sessions`.
- **Downloads** at `/downloads/`: the CLI for Linux and macOS (x64 and arm64), each
  with a `.sha256`, and the Claude Code plugin as a local marketplace, with install
  instructions on the page. Built from the same sources as the app, so the versions
  match.
- **The source repository**, cloned at build time to `/workspace/claude-transcripts`
  and fetched on every boot (best-effort; set `OMNIBUS_GIT_FETCH=0` to skip). It can
  fetch but not push: the remote has no push URL, and a system-wide `pre-push` hook
  refuses pushes from any repository in the container.
- **The GitHub CLI** (`gh`), with no credentials. Public reads work, unauthenticated
  and rate-limited.

## Recording sessions from the host

The hook writes to CouchDB and S3 directly, not through the webapi
([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).
So a host recording into the omnibus needs 7652 and 7653 published as well as 7650,
and the CouchDB password and S3 key from `/data/secrets` (below).

## Configuration

Environment variables only, all optional.

| Variable | Default | |
|----------|---------|---|
| `OMNIBUS_BIND` | `0.0.0.0` | The interface every service except the webapi binds. `127.0.0.1` keeps them unreachable from outside the container even if their ports are published |
| `COUCHDB_PORT`, `GARAGE_S3_PORT`, `GARAGE_ADMIN_PORT`, `GARAGE_WEBUI_PORT`, `MEILI_PORT`, `MEILI_UI_PORT`, `FOSSIL_PORT` | see the table above | Ports inside the container |
| `WEBAPI_PORT` | `7650` | |
| `COUCHDB_USER` | `admin` | |
| `COUCHDB_PASSWORD` | generated | |
| `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN` | generated | |
| `MEILI_MASTER_KEY` | generated | The webapi uses it as `MEILI_API_KEY` |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | minted at first boot | The app's key on its bucket |
| `OMNIBUS_GIT_FETCH` | `1` | Fetch the source clone on boot |
| `OMNIBUS_WAIT_SECONDS` | `120` | How long provisioning waits for each service |
| `OMNIBUS_MAX_RESTARTS`, `OMNIBUS_RESTART_WINDOW` | `5`, `60` | A core service that dies this many times in this many seconds stops the container |

A secret you don't supply is generated on first boot and kept in `/data/secrets/`
(one file per variable, plus `s3.env` for the S3 key), so restarts and upgrades reuse
it. A variable you do supply wins over the stored one. App configuration (`config/`)
is the image's template; mount `/app/config/config.json` to override it.

Build arguments: `APP_IMAGE` and `FOSSIL_IMAGE` (the component images to assemble;
`omnibus:build` passes the ones it just built), `OMNIBUS_GIT_URL` and
`OMNIBUS_GIT_REF` (the repository to clone), and the pinned upstream images and
versions at the top of `deploy/omnibus/Dockerfile`.

## How it starts

s6-overlay is PID 1. The services, in `deploy/omnibus/rootfs/etc/s6-overlay/s6-rc.d/`:

1. `init-firstboot` (oneshot) lays out `/data`, settles ports and secrets, and renders
   the CouchDB and Garage config. On every boot. Anything it generates is generated
   once.
2. `couchdb`, `garage`, `meilisearch`, `fossil` (longruns). Fossil's start seeds the
   configured repositories, the same way the Fossil image does.
3. `init-provision` (oneshot) waits until each of the four answers, then makes sure the
   CouchDB system databases exist and runs the dev stack's Garage bootstrap (layout,
   bucket, app key). Idempotent.
4. `webapi`, `garage-ui` (longruns), after provisioning. The webapi creates its
   databases and search indexes as it does anywhere else.

`meilisearch-ui` and `git-fetch` only wait for step 1.

If a core service never becomes ready, provisioning fails and the container stops. If
one keeps dying after that, its `finish` script stops the container, so the host's
restart policy and monitoring notice. `docker exec claude-transcripts omnibus-health`
prints every service's state; the `HEALTHCHECK` runs the same script.

## Upgrade and backup

- **Upgrade**: pull or build the new image, then recreate the container on the same
  volume. Provisioning re-runs and changes nothing that exists. Meilisearch needs a
  dump and import across a major version; release notes will say when that applies.
- **Backup**: stop the container and copy the volume.

  ```bash
  docker stop claude-transcripts
  docker run --rm -v ct-omnibus:/data -v "$PWD":/backup alpine tar -czf /backup/ct-omnibus.tgz -C /data .
  docker start claude-transcripts
  ```

## Trade-offs

- One health status for seven processes.
- Every component upgrades with the image, in lockstep.
- One memory budget, no per-service limits.
- A bigger image than any single component.
