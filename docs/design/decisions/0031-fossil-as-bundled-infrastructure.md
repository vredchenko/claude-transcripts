# 31. Fossil as bundled infrastructure, built from source

Date: 2026-10-03

## Status

Accepted. The repository is seeded on start and the webapi reads it through a read-only
proxy; nothing writes it yet.

## Context

[Fossil](https://fossil-scm.org) is a distributed version control system whose one
self-contained binary is also its server: repositories, a web UI (timeline, files,
diffs), a wiki, tickets and a forum, plus the HTTP sync endpoint that `fossil clone`
and `fossil sync` talk to. A repository is a single SQLite file. That makes it a
cheap thing to stand up next to CouchDB and Garage: one container, one directory of
state, no database of its own to run.

We want it available in the bundled stack now, so later work can version things
(projects touched by sessions, artifacts derived from them) without first having to
solve deployment. Two facts shape how:

- **Fossil publishes no container image.** It ships a `Dockerfile` in its source tree
  ([containers.md](https://fossil-scm.org/home/doc/trunk/www/containers.md)) and
  release tarballs. So the mirror-an-upstream-image route of
  [ADR 0024](0024-mirror-backing-images-to-registry.md) has nothing to mirror.
- **Every deploy shape must still work with no registry.** `--upstream` (dev) and
  `install` start the stack from a bare machine; the Kubernetes base
  ([ADR 0030](0030-kubernetes-deploy-generated-from-the-model.md)) pulls by name.

## Decision

1. **A `fossil` backing service in the app model**, beside CouchDB and Garage, so
   compose, the Kubernetes base, the env schema, the installer's port block
   (`FOSSIL_PORT`, default 7658), the services menu and the architecture diagram all
   project from one entry. No feature flag and no diagram edges: it is not wired, and
   an arrow would claim otherwise.
2. **Built from the official release source**, by `deploy/fossil/Dockerfile`: upstream's
   own recipe (a static musl binary on `scratch`), pinned to a release tarball and
   verified by sha256 instead of tracking trunk. The model's `defaultTag` and the
   Dockerfile's `FOSSIL_VERSION` are held equal by a test.
3. **A new `image.build` field** marks "we build this, there is no upstream image".
   The projections treat it as a third kind of image alongside mirrored and our own:
   - the base compose file and the Kubernetes base pull
     `claude-transcripts-fossil:<version>` from the registry, like any mirrored image;
   - `mirror-images` builds and pushes it under that name (`toImageBuildPlan`);
   - the upstream override builds it locally, from a build context that needs nothing
     outside `deploy/fossil/` — which `install` ships — so the no-registry paths still
     need no registry.
4. **One repository, named in config, seeded by the container on start.** The name
   comes from `fossil.repositories` in `config/` (default `claude-transcripts-sessions`),
   a keyed map like `couchdb.databases` and `s3.buckets`, and lands in the model's
   `stores`. Fossil has no HTTP call that creates a repository, so the seed runs where
   the binary and the volume are: the image's entrypoint creates each repository named
   in `FOSSIL_REPOSITORIES` that doesn't exist yet (`fossil new`, as an idempotent step
   like CouchDB creating its admin from env), then execs `fossil server --repolist
   /museum`. The runners pass that variable from the live config at `up` time
   (`toStoreEnv`), so renaming a repository needs no regeneration. Not upstream's
   `--create`, which makes a generic repository with a printed admin password. The
   image carries one static busybox for the entrypoint script, as upstream's container
   docs suggest when a shell is needed.
5. **Root in the container**, for now. Unlike upstream's image it runs as root,
   because the state directory is a bind mount or volume owned by whoever started the
   stack; Fossil's own jail drops each request's privileges to the owner of the
   directory it serves whenever that owner isn't root. Most of the other bundled
   services also start as root. Running every service as the stack owner's UID
   (`PUID`/`PGID`) is tracked separately.
6. **No auth**, like the rest of the bundled stack
   ([ADR 0020](0020-bundled-services-default-no-auth.md)): the seed gives Fossil's
   built-in `nobody` user every capability (`fossil user capabilities nobody s`). A
   repository still needs one real user, `claude-transcripts`; its generated password
   is discarded.
   Single sign-on with CouchDB and Garage comes later; Fossil supports it through
   `REMOTE_USER` when run as CGI/SCGI behind a proxy.
7. **Read through the gateway** ([ADR 0016](0016-webapi-is-the-io-gateway.md)), like
   CouchDB and S3: `/api/fossil/<repoKey>/json/...` proxies Fossil's JSON API, which the
   image is built with (`--json`). Fossil's own port stays published on the host
   (7658), as CouchDB's, Garage's and Meilisearch's are. The proxy is an **allowlist**
   of read-only commands, not a GET filter: the JSON API reads parameters from the
   query string, so a GET can write (`/json/user/save?…` grants setup rights), and a
   bare `/json?command=…` dispatches to any command.

**No Fossil CLI on the client side.** Clients that ever need to reach a repository do
it over HTTP, through the web UI or a future gateway route; nothing installs `fossil`
on the user's machine.

## Consequences

- Fossil's JSON API is documented upstream as unfinished; a release may change it, and
  the allowlist is reviewed on each Fossil bump.
- One more container and one more port in every bundled deploy; existing installs
  pick up `FOSSIL_PORT` as the next port after their block.
- A Fossil upgrade is a reviewed change to three values in one Dockerfile plus the
  model's tag, not a moving `latest`.
- The first `--upstream` start compiles Fossil (about a minute); later starts reuse the
  local image.
- A seeded repository is not quite empty: `fossil new` always records an initial empty
  check-in.
- Renaming a repository in config seeds a new one; the old file stays in the data
  directory, served, until someone removes it
  ([#211](https://github.com/vredchenko/claude-transcripts/issues/211)).
- The seed's contents beyond an empty, open repository — users and roles, wiki, ticket
  schema, tags, settings — are a placeholder (`seed_content`) until
  [#210](https://github.com/vredchenko/claude-transcripts/issues/210) defines them.
- Kubernetes reads `FOSSIL_REPOSITORIES` from the instance Secret like every other
  `${VAR:-default}` reference, so an existing `.env` needs the new key.
