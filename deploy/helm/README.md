# Helm chart

The stack the compose file and the kustomize base run (CouchDB, Garage, Fossil,
Meilisearch, their admin UIs and the app) as a Helm chart, for k3s or any Kubernetes
with a default StorageClass. Works with `helm`, and with Argo CD or Flux (see
[GitOps](#gitops-argo-cd-flux)).

```bash
helm install claude-transcripts oci://ghcr.io/<owner>/charts/claude-transcripts \
  --version 0.8.0 -n claude-transcripts --create-namespace
kubectl -n claude-transcripts get pods -w
```

Or from a checkout: `helm install claude-transcripts deploy/helm/claude-transcripts -n claude-transcripts --create-namespace`.

```
deploy/helm/
├── claude-transcripts/   GENERATED (bun run gen:helm) — do not edit
│   ├── Chart.yaml            version + appVersion = the release
│   ├── values.yaml           every knob, commented
│   ├── templates/            one file per service, plus the env Secret, provisioning, Ingress
│   └── files/provision.ts    copied from ./provision.ts
└── provision.ts          the provisioning Job's script (hand-written)
```

The chart is a **projection of the blueprint** (`toHelmChart` in
`packages/shared/src/blueprint/helm.ts`). It starts from the same objects as the
kustomize base and adds template hooks for what an installer chooses, so the two
can't drift. Change the blueprint, run `bun run gen:helm` (part of `gen:all`; CI fails
on a stale chart). Rationale: [ADR 0030, amendment](../../docs/design/decisions/0030-kubernetes-deploy-generated-from-the-model.md#amendment-a-helm-chart-too-generated-the-same-way).

## What installing does

1. **The env Secret** (`claude-transcripts-env`) is rendered from `values.env`. Any
   value you don't set keeps what the cluster already holds, or is generated on first
   install: `COUCHDB_PASSWORD` and Garage's three tokens.
2. **The workloads** start: one Deployment, Service and PVC set per service, the same
   as the base. The PVCs carry `helm.sh/resource-policy: keep`, so `helm uninstall`
   leaves your data (set `persistence.keep=false` to change that).
3. **Provisioning** runs as a post-install/post-upgrade Job from the app image:
   `claude-transcripts provision` creates CouchDB's databases and Garage's layout,
   bucket and app key. The key goes into its own Secret, `claude-transcripts-s3`, and
   the app is restarted to pick it up. The chart never renders that Secret, so
   upgrades and syncs leave the key alone. The Job is idempotent: with the key present
   it mints nothing.

Upgrade with `helm upgrade` (same values): secrets are kept and nothing is re-minted.

## Values

The ones you're most likely to set; `values.yaml` has them all.

| Value | Default | |
|-------|---------|---|
| `images.<service>` | pinned upstream refs; ours at this release | Point any image at a mirror |
| `<service>.enabled` | `true` | Everything but `app` and `couchdb` can be turned off |
| `<service>.resources` | `{}` | Requests and limits per service |
| `persistence.storageClass` | cluster default | k3s: `local-path` |
| `persistence.size` | `10Gi` | Per volume |
| `persistence.keep` | `true` | Volumes survive `helm uninstall` |
| `env.<VAR>` | see above | Any variable from `deploy/k8s/base/.env.template` |
| `existingSecret` | `""` | Use a Secret you manage instead of rendering one |
| `ingress.enabled`, `.host`, `.className`, `.tls`, `.annotations` | off | An Ingress for the app |

The stack has no auth ([ADR 0020](../../docs/design/decisions/0020-bundled-services-default-no-auth.md)):
nothing is exposed unless you enable the Ingress, and then only the app. Put it on a
network you trust. To reach everything from your machine, on the ports the compose stack
uses (so the hook's and CLI's defaults work unchanged), see the install notes
(`helm get notes claude-transcripts -n claude-transcripts`).

## GitOps (Argo CD, Flux)

Argo CD renders charts with `helm template`, which can't read the cluster, so the
"keep what's there" step can't work. Every render would generate fresh secrets. So
under Argo CD, either:

- set `existingSecret` to a Secret you manage (sealed-secrets, External Secrets, …)
  holding the keys in `deploy/k8s/base/.env.template`, or
- set every generated secret in `env` (`COUCHDB_PASSWORD`, `GARAGE_RPC_SECRET` as 64
  hex characters, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`).

The provisioning Job runs as a PostSync hook there, and the S3 key it mints is safe
from self-heal, because the chart doesn't render that Secret. Flux's helm-controller
runs real Helm, so `lookup` works and neither step is needed.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: claude-transcripts
  namespace: argocd
spec:
  project: default
  source:
    repoURL: ghcr.io/<owner>/charts
    chart: claude-transcripts
    targetRevision: 0.8.0
    helm:
      valuesObject:
        existingSecret: claude-transcripts-env-managed
  destination:
    server: https://kubernetes.default.svc
    namespace: claude-transcripts
  syncPolicy:
    syncOptions: [CreateNamespace=true]
```

## Recording sessions

As with the kustomize base, the hook writes to CouchDB and S3 directly, so the machine
running Claude Code needs a route to those two Services (port-forward, an Ingress of
your own, a tailnet). See [deploy/k8s/README.md](../k8s/README.md#reaching-it).

## Testing it

`bun run helm:smoke` installs the chart into a scratch namespace on the cluster kubectl
points at and checks it: the S3 key minted, a transcript written and read back through
it, then an upgrade that keeps every secret. Extra arguments go to `helm`
(`-- --set images.app=…`). CI runs it on kind with an app image built from the commit
(`.github/workflows/chart.yml`).
