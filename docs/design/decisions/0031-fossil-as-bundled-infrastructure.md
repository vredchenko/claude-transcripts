# 31. Fossil as bundled infrastructure, built from source

Date: 2026-10-03

## Status

Accepted. Infrastructure only: nothing in the app reads or writes Fossil yet.

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
4. **One repository, named in config, created by the app — not the container.** The
   name comes from `fossil.repositories` in `config/` (default
   `claude-transcripts-sessions`), a keyed map like `couchdb.databases` and
   `s3.buckets`, and lands in the model's `stores`. The container serves its data
   directory (`fossil server --repolist /museum`) and creates nothing: upstream's
   `--create` would make a repository with a generated admin password, and the app's
   repository is seeded by the app. How that seed authenticates is still open.
5. **Root in the container**, for now. Unlike upstream's image it runs as root,
   because the state directory is a bind mount or volume owned by whoever started the
   stack; Fossil's own jail drops each request's privileges to the owner of the
   directory it serves whenever that owner isn't root. Most of the other bundled
   services also start as root.

**No Fossil CLI on the client side.** Clients that ever need to reach a repository do
it over HTTP, through the web UI or a future gateway route; nothing installs `fossil`
on the user's machine.

## Consequences

- One more container and one more port in every bundled deploy; existing installs
  pick up `FOSSIL_PORT` as the next port after their block.
- A Fossil upgrade is a reviewed change to three values in one Dockerfile plus the
  model's tag, not a moving `latest`.
- The first `--upstream` start compiles Fossil (about a minute); later starts reuse the
  local image.
- Until the seed exists, the web UI lists no repositories.
