import { ENV_VARS } from "./env";
import { RELEASE_IMAGE_NS } from "./services";
import type { AppModel, ServiceDef } from "./types";

/**
 * Kubernetes projection — the same services topology that becomes
 * `deploy/docker-compose.yml`, projected as a **kustomize base** of plain manifests
 * (Namespace, ConfigMaps, PersistentVolumeClaims, Deployments, Services). The
 * gen-k8s script serialises this to `deploy/k8s/base/`; nothing there is
 * hand-maintained. See docs/design/decisions/0030-kubernetes-deploy-generated-from-the-model.md.
 *
 * Where compose interpolates `${VAR}` from `.env`, a manifest cannot — so every
 * `${VAR}` reference in a service's `containerEnv` becomes a `secretKeyRef` into ONE
 * Secret (`K8S_ENV_SECRET`), which kustomize builds from a `.env`-shaped file next to
 * the kustomization. Compose's `env_file:` becomes `envFrom:` on the same Secret. That
 * keeps the two deploy shapes fed by the same variable names.
 *
 * Isomorphic and pure like the rest of the model: no fs, no YAML. The generator
 * hands in the contents of any read-only file mounts (e.g. garage.toml) via `files`.
 */

/** A Kubernetes object, loosely typed — we emit, we don't consume. */
export interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [key: string]: unknown;
}

export interface KubernetesOptions {
  /** Default `"claude-transcripts"`. */
  namespace?: string;
  /**
   * Contents of read-only file mounts, keyed by the mount's compose-relative host
   * path (e.g. `"./garage.toml"`). Each becomes a ConfigMap; a missing entry throws,
   * because a silently empty config file is worse than no manifest.
   */
  files?: Record<string, string>;
  /** `storageClassName` for every PVC. Unset ⇒ the cluster default (k3s: local-path). */
  storageClassName?: string;
  /** PVC size for data volumes. Default `"10Gi"`. */
  storageSize?: string;
}

/** Name of the Secret every `${VAR}` in `containerEnv` resolves against. */
export const K8S_ENV_SECRET = "claude-transcripts-env";
export const K8S_DEFAULT_NAMESPACE = "claude-transcripts";
/** Every object carries this label pair, so `kubectl get all -l app.kubernetes.io/part-of=…` works. */
export const K8S_PART_OF = "claude-transcripts";

/** Roles that become workloads. Host components (webapi/webui/cli) are inside the app image. */
const WORKLOAD_ROLES = new Set(["backing", "admin-ui", "app"]);

/** Services the projection emits workloads for, in model order. */
export function k8sWorkloadServices(model: AppModel): ServiceDef[] {
  return model.services.filter((s) => WORKLOAD_ROLES.has(s.role) && s.image);
}

/**
 * Parse one compose-style env value. `${VAR}` and `${VAR:-default}` both become a
 * reference to `VAR`; anything else is a literal. Mixed strings (`http://${HOST}/x`)
 * are not used by the model and are rejected rather than half-translated.
 */
export function parseEnvValue(
  value: string,
): { kind: "literal"; value: string } | { kind: "ref"; name: string; fallback?: string } {
  const m = /^\$\{([A-Z0-9_]+)(?::-(.*))?\}$/.exec(value);
  if (m?.[1]) {
    const name = m[1];
    return m[2] === undefined ? { kind: "ref", name } : { kind: "ref", name, fallback: m[2] };
  }
  if (value.includes("${")) {
    throw new Error(`containerEnv value "${value}" mixes literal and \${VAR} — not projectable`);
  }
  return { kind: "literal", value };
}

/**
 * The env var names the projection expects in the env Secret, with the default
 * compose would have applied (`${VAR:-default}`) where there is one. The generator
 * renders this as the `.env.template` beside the kustomization; a key without a
 * fallback is one the operator must fill in.
 */
export function k8sSecretKeys(model: AppModel): Array<{ name: string; fallback?: string }> {
  const keys = new Map<string, string | undefined>();
  // A service with an env_file (the app) gets the whole Secret via envFrom — so
  // every secret-scoped variable of the env schema is a key the file may carry.
  if (k8sWorkloadServices(model).some((s) => s.envFile)) {
    for (const v of ENV_VARS) if (v.scope === "secret") keys.set(v.name, v.default);
  }
  for (const s of k8sWorkloadServices(model)) {
    for (const v of Object.values(s.containerEnv ?? {})) {
      const parsed = parseEnvValue(v);
      if (parsed.kind !== "ref") continue;
      if (!keys.has(parsed.name) || keys.get(parsed.name) === undefined) {
        keys.set(parsed.name, parsed.fallback);
      }
    }
  }
  return [...keys.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, fallback]) => (fallback === undefined ? { name } : { name, fallback }));
}

/** `./data/garage/meta` → `garage-meta`; `./data/couchdb` → `couchdb-data`. */
export function k8sVolumeName(serviceKey: string, hostPath: string): string {
  const rel = hostPath.replace(/^\.\//, "").replace(/^data\//, "");
  const parts = rel.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "data";
  return last === serviceKey ? `${serviceKey}-data` : `${serviceKey}-${last}`;
}

/** `./garage.toml` → ConfigMap `garage-config`, key `garage.toml`. */
export function k8sFileConfigName(serviceKey: string): string {
  return `${serviceKey}-config`;
}

function labelsFor(key: string): Record<string, string> {
  return {
    "app.kubernetes.io/name": key,
    "app.kubernetes.io/part-of": K8S_PART_OF,
  };
}

function containerImage(s: ServiceDef): string {
  const img = s.image;
  if (!img) throw new Error(`service ${s.key} has no image`);
  // The base pins the canonical upstream image so `kubectl apply -k` works from a
  // fresh clone with no mirror. Our own images (the app) have no upstream and use the
  // mirrored name; kustomize's `images:` transformer retargets either (see README).
  return `${img.upstream ?? `${RELEASE_IMAGE_NS}/claude-transcripts-${img.name}`}:${img.defaultTag}`;
}

function containerEnv(s: ServiceDef): Array<Record<string, unknown>> {
  return Object.entries(s.containerEnv ?? {}).map(([name, raw]) => {
    const parsed = parseEnvValue(raw);
    if (parsed.kind === "literal") return { name, value: parsed.value };
    return { name, valueFrom: { secretKeyRef: { name: K8S_ENV_SECRET, key: parsed.name } } };
  });
}

function probeFor(s: ServiceDef): Record<string, unknown> | undefined {
  if (s.httpHealth) {
    return {
      httpGet: { path: s.httpHealth.path, port: s.httpHealth.port },
      initialDelaySeconds: 10,
      periodSeconds: 10,
      failureThreshold: 6,
    };
  }
  if (!s.healthcheck) return undefined;
  const cmd = s.healthcheck.test[0] === "CMD" ? s.healthcheck.test.slice(1) : s.healthcheck.test;
  // `curl -f http://localhost:PORT/path` is what compose can do; kubelet probes HTTP itself.
  const url = cmd[0] === "curl" ? cmd.find((a) => a.startsWith("http://localhost:")) : undefined;
  const m = url ? /^http:\/\/localhost:(\d+)(\/.*)?$/.exec(url) : null;
  const handler = m
    ? { httpGet: { path: m[2] ?? "/", port: Number(m[1]) } }
    : { exec: { command: cmd } };
  return {
    ...handler,
    initialDelaySeconds: 10,
    periodSeconds: 30,
    timeoutSeconds: 10,
    failureThreshold: s.healthcheck.retries ?? 3,
  };
}

/**
 * Project every Kubernetes object the bundled stack needs, in apply order. Objects
 * are grouped per service by `metadata.labels["app.kubernetes.io/name"]`, which is
 * what the generator uses to split them into one file per service.
 */
export function toKubernetesObjects(
  model: AppModel,
  opts: KubernetesOptions = {},
): KubernetesObject[] {
  const ns = opts.namespace ?? K8S_DEFAULT_NAMESPACE;
  const files = opts.files ?? {};
  const out: KubernetesObject[] = [];

  out.push({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: ns, labels: { "app.kubernetes.io/part-of": K8S_PART_OF } },
  });

  for (const s of k8sWorkloadServices(model)) {
    const labels = labelsFor(s.key);
    const meta = (name: string) => ({ name, namespace: ns, labels });
    const volumes: Array<Record<string, unknown>> = [];
    const mounts: Array<Record<string, unknown>> = [];

    for (const v of s.volumes ?? []) {
      if (v.readonly) {
        const content = files[v.host];
        if (content === undefined) {
          throw new Error(`no content supplied for read-only mount ${v.host} (service ${s.key})`);
        }
        const fileName = v.container.split("/").pop() ?? "config";
        const cmName = k8sFileConfigName(s.key);
        out.push({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: meta(cmName),
          data: { [fileName]: content },
        });
        volumes.push({ name: cmName, configMap: { name: cmName } });
        mounts.push({ name: cmName, mountPath: v.container, subPath: fileName, readOnly: true });
        continue;
      }
      const pvc = k8sVolumeName(s.key, v.host);
      out.push({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: meta(pvc),
        spec: {
          accessModes: ["ReadWriteOnce"],
          ...(opts.storageClassName ? { storageClassName: opts.storageClassName } : {}),
          resources: { requests: { storage: opts.storageSize ?? "10Gi" } },
        },
      });
      volumes.push({ name: pvc, persistentVolumeClaim: { claimName: pvc } });
      mounts.push({ name: pvc, mountPath: v.container });
    }

    const container: Record<string, unknown> = {
      name: s.key,
      image: containerImage(s),
    };
    if (s.envFile) container.envFrom = [{ secretRef: { name: K8S_ENV_SECRET } }];
    const env = containerEnv(s);
    if (env.length) container.env = env;
    if (s.ports?.length) {
      container.ports = s.ports.map((p) => ({
        name: portName(p.label),
        containerPort: p.internal,
      }));
    }
    const probe = probeFor(s);
    if (probe) container.readinessProbe = probe;
    if (mounts.length) container.volumeMounts = mounts;

    const hasState = volumes.some((v) => "persistentVolumeClaim" in v);
    out.push({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta(s.key),
      spec: {
        replicas: 1,
        // RWO volumes can't be shared with a rolling replacement pod.
        ...(hasState ? { strategy: { type: "Recreate" } } : {}),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [container],
            ...(volumes.length ? { volumes } : {}),
          },
        },
      },
    });

    if (s.ports?.length) {
      out.push({
        apiVersion: "v1",
        kind: "Service",
        metadata: meta(s.key),
        spec: {
          // ClusterIP, deliberately: the stack has no auth (ADR 0020), so reaching it is
          // the overlay's decision — port-forward, an Ingress, a tailnet — not the base's.
          selector: labels,
          ports: s.ports.map((p) => ({
            name: portName(p.label),
            port: p.internal,
            targetPort: p.internal,
          })),
        },
      });
    }
  }
  return out;
}

/** "S3 API" → `s3-api`; no label → `http`. */
function portName(label?: string): string {
  if (!label) return "http";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 15);
}

/** The kustomization that ties the generated files together. */
export function toKustomization(files: string[], opts: KubernetesOptions = {}) {
  return {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    namespace: opts.namespace ?? K8S_DEFAULT_NAMESPACE,
    resources: files,
    secretGenerator: [
      {
        name: K8S_ENV_SECRET,
        envs: [".env"],
        // A fixed name: the Deployments reference it by name, and secrets that only
        // ever change with an `apply` don't need the hash-suffix rollout trick.
        options: { disableNameSuffixHash: true },
      },
    ],
  };
}
