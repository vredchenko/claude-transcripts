# Deploy on Kubernetes (k3s and friends)

The same stack `deploy/docker-compose.yml` runs — CouchDB, Garage (S3), Meilisearch,
their three admin UIs, and the app — as a **kustomize base**, for a single-node k3s
cluster or any Kubernetes with a default StorageClass.

```
deploy/k8s/
├── base/                 GENERATED (bun run gen:k8s) — do not edit
│   ├── kustomization.yaml    resources + the Secret built from ./.env
│   ├── .env.template         → copy to .env; the variables the Secret carries
│   ├── namespace.yaml        claude-transcripts
│   ├── couchdb.yaml          PVC + Deployment + Service   (5984)
│   ├── garage.yaml           2 PVCs + ConfigMap(garage.toml) + Deployment + Service (3900, 3903)
│   ├── garage-ui.yaml        Deployment + Service         (3909)
│   ├── meilisearch.yaml      PVC + Deployment + Service   (7700)
│   ├── meilisearch-ui.yaml   Deployment + Service         (24900)
│   └── app.yaml              Deployment + Service         (7650)
└── overlays/
    └── ingress/          hand-written EXAMPLE: one Ingress host per service + image overrides
```

The base is a **projection of the app model** (`toKubernetesObjects` in
`packages/shared/src/model/k8s.ts`), the sibling of the compose projection — same
images, ports, env names, healthchecks and state, so the two deploy shapes cannot
drift. Change `packages/shared/src/model/services.ts`, run `bun run gen:k8s` (part of
`gen:all`; CI fails on a stale diff). Overrides go in an overlay, never in `base/`.
Rationale: [ADR 0030](../../docs/design/decisions/0030-kubernetes-deploy-generated-from-the-model.md).

## Run it

```bash
cd deploy/k8s/base
cp .env.template .env            # then fill in the Garage secrets: openssl rand -hex 32
kubectl apply -k .               # or, from the repo root: kubectl apply -k deploy/k8s/base
kubectl -n claude-transcripts get pods -w
```

What you get, and how it maps to the compose stack:

| Compose | Kubernetes |
|---|---|
| repo-root `.env`, interpolated into `${VAR}` | Secret `claude-transcripts-env`, generated from `base/.env`; every `${VAR}` became a `secretKeyRef`, the app's `env_file` became `envFrom` |
| `./data/*` bind mounts | one `PersistentVolumeClaim` per mount (`couchdb-data`, `garage-meta`, `garage-data`, `meilisearch-data`), 10Gi, default StorageClass (k3s: `local-path`) |
| `./garage.toml:ro` | ConfigMap `garage-config`, inlined from `deploy/garage.toml` at generation time |
| service names on the compose network | ClusterIP Services of the same names — `couchdb:5984`, `garage:3900`, `meilisearch:7700` — so the app's in-cluster endpoints are literally the compose ones |
| `127.0.0.1:765x` published ports | **nothing published.** See *Reaching it* |
| `healthcheck:` | `readinessProbe` (HTTP where compose used `curl`, `exec` otherwise; the app probes `/health`) |
| `${IMAGE_NS}` mirror | pinned **upstream** images (the `--upstream` posture), the app from the project's release registry — retarget with kustomize `images:` |
| `profiles: [app]` (opt-in app) | the app is always in (this is a deploy, not a dev stack) |

## Reaching it

The base publishes nothing on purpose: the stack has **no auth**
([ADR 0020](../../docs/design/decisions/0020-bundled-services-default-no-auth.md)), so
exposure is your decision, not the base's. Two ways:

- **Port-forward** (same ports the compose stack uses on localhost):
  ```bash
  kubectl -n claude-transcripts port-forward svc/app 7650:7650 &
  kubectl -n claude-transcripts port-forward svc/couchdb 7652:5984 &
  kubectl -n claude-transcripts port-forward svc/garage 7653:3900 7654:3903 &
  kubectl -n claude-transcripts port-forward svc/garage-ui 7655:3909 &
  kubectl -n claude-transcripts port-forward svc/meilisearch 7656:7700 &
  kubectl -n claude-transcripts port-forward svc/meilisearch-ui 7657:24900 &
  ```
  With those up, the repo-root `.env` defaults (`COUCHDB_PORT=7652`, `S3_ENDPOINT=http://127.0.0.1:7653`, …)
  and the hook work unchanged.
- **Ingress** — `overlays/ingress/` is a starting point (k3s' Traefik picks it up with
  no class set). Put it on a network you trust; a tailnet works well.

## One-time Garage bootstrap

Exactly as for compose (`deploy/README.md`): Garage needs a layout, the bucket and an
app key before first use. Run the CLI inside the pod, or port-forward the admin API
(3903) and use the project's bootstrap script:

```bash
kubectl -n claude-transcripts exec deploy/garage -- /garage status
kubectl -n claude-transcripts exec deploy/garage -- /garage layout assign -z dc1 -c 10G <node-id>
kubectl -n claude-transcripts exec deploy/garage -- /garage layout apply --version 1
kubectl -n claude-transcripts exec deploy/garage -- /garage bucket create claude-transcripts-sessions
kubectl -n claude-transcripts exec deploy/garage -- /garage key create claude-transcripts
kubectl -n claude-transcripts exec deploy/garage -- /garage bucket allow --read --write claude-transcripts-sessions --key claude-transcripts
```

Then put the key into `base/.env` (`S3_ACCESS_KEY` / `S3_SECRET_KEY`) and re-apply — the
Secret has a fixed name, so restart the app to pick it up:
`kubectl -n claude-transcripts rollout restart deploy/app`.

## Overriding things

All via overlays (`kustomize` patches) — never by editing `base/`:

- **Images / mirror / release pin**: `images:` in the overlay (commented example in
  `overlays/ingress/kustomization.yaml`). Private registry → add `imagePullSecrets`
  with a patch.
- **App config** (db/bucket/index names, feature flags, services-menu links): the image
  carries the defaults; to change them mount a ConfigMap at `/config` and set
  `CT_CONFIG_DIR=/config` on the app — see
  [configuration.md](../../docs/start/configuration.md).
- **Storage size / class**: patch the PVCs, or an external CouchDB/S3/Meilisearch —
  drop the service from the overlay's resources and point the app's `COUCHDB_URL` /
  `S3_ENDPOINT` / `MEILI_HOST` at it ([ADR 0028](../../docs/design/decisions/0028-external-vs-bundled-meilisearch.md)).
- **Resources**: none are set in the base (a single-user stack on a single node);
  patch `resources:` in if your cluster enforces quotas.

## Reset

`kubectl delete -k deploy/k8s/base` removes everything **including the PVCs** (they
are part of the base) — the equivalent of wiping `deploy/data/`. To keep the data,
delete only the Deployments.
