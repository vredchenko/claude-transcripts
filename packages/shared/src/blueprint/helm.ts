import {
  K8S_ENV_SECRET,
  K8S_PART_OF,
  type KubernetesObject,
  k8sImageRef,
  k8sSecretKeys,
  k8sWorkloadServices,
  toKubernetesObjects,
} from "./k8s";
import type { AppBlueprint, ServiceDef } from "./types";

/**
 * Helm projection — the third shape of the same services topology, beside the compose
 * file and the kustomize base (ADR 0030 and its amendment). It starts from exactly the
 * objects `toKubernetesObjects` emits and swaps in template expressions where a value
 * belongs to the person installing: images, storage, resources, which optional services
 * run, the Secret's name. So the chart and the base cannot drift; the chart only adds
 * what a published, versioned install needs that a base cannot have:
 *
 * - **Secrets generated once and kept.** The env Secret is rendered with `lookup`, so a
 *   value you didn't set is generated on install and read back on every upgrade.
 * - **Provisioning as a hook.** A post-install/post-upgrade Job runs the CLI's own
 *   `provision` (CouchDB databases, Garage layout, bucket and key) and keeps the minted
 *   S3 key in a Secret of its own, which the chart never renders — so neither a
 *   `helm upgrade` nor a GitOps sync can overwrite it.
 *
 * Isomorphic and pure like the rest of the blueprint: no fs, no YAML. The generator
 * (scripts/gen-helm.ts) serialises the objects and passes the text through
 * {@link HelmChart.render}, which turns the placeholders below into template syntax.
 */

export const HELM_CHART_NAME = "claude-transcripts";

/** The Secret the provisioning Job creates with the S3 key it minted. Never rendered by the chart. */
export const HELM_S3_SECRET = "claude-transcripts-s3";

/**
 * Secrets the chart generates when you don't supply them, and their entropy in bytes
 * (rendered as hex: Garage requires its RPC secret as exactly 32 bytes of hex). A
 * generated CouchDB password, unlike the base's `admin`, because a chart is installed
 * by people who never read the defaults.
 */
export const HELM_GENERATED_SECRETS: Record<string, number> = {
  COUCHDB_PASSWORD: 16,
  GARAGE_ADMIN_TOKEN: 32,
  GARAGE_METRICS_TOKEN: 32,
  GARAGE_RPC_SECRET: 32,
};

/** Keys the provisioning Job owns; in the env Secret only when set explicitly (external S3). */
const S3_KEYS = new Set(["S3_ACCESS_KEY", "S3_SECRET_KEY"]);

/** Services that always run: the Tier 1 core. The rest get `<service>.enabled`. */
const CORE_SERVICES = new Set(["app", "couchdb"]);

/** `garage-ui` → `garageUi`: the values key for a service. */
export function helmValuesKey(serviceKey: string): string {
  return serviceKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** One file under `templates/`. Objects are serialised in order, `---`-separated. */
export interface HelmTemplate {
  name: string;
  objects: unknown[];
  /** Wraps the whole file: `{{- if <condition> }}` … `{{- end }}`. */
  condition?: string;
}

export interface HelmChart {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  /** Comments for values.yaml, keyed by dotted path. */
  valuesComments: Record<string, string>;
  templates: HelmTemplate[];
  /** Verbatim template files (`_helpers.tpl`, `NOTES.txt`). */
  rawTemplates: Record<string, string>;
  /**
   * Turn serialised YAML into template text: each expression placeholder becomes its
   * `{{ … }}`, each block placeholder line becomes its lines at that indentation.
   */
  render(yamlText: string): string;
}

export interface HelmChartOptions {
  /** Read-only file mounts, as for {@link toKubernetesObjects}. */
  files: Record<string, string>;
  /** The lockstep release (ADR 0023); the chart's version and appVersion. */
  releaseVersion: string;
}

/**
 * Placeholders that survive YAML serialisation untouched — plain alphanumeric scalars
 * and keys — and are swapped for template syntax afterwards.
 */
class Placeholders {
  private exprs: string[] = [];
  private blocks: string[][] = [];

  /** A scalar that renders as the given template text. */
  expr(text: string): string {
    this.exprs.push(text);
    return `HELMX${this.exprs.length - 1}X`;
  }

  /**
   * A map key that renders as the given lines at the key's indentation. In a line, `{N}`
   * becomes that indentation's width and `{N2}` the width one level deeper, for `nindent`.
   */
  block(lines: string[]): string {
    this.blocks.push(lines);
    return `HELMB${this.blocks.length - 1}B`;
  }

  render(text: string): string {
    return text
      .replace(/^( *)HELMB(\d+)B: (?:null|""|~)?$/gm, (_, indent: string, i: string) =>
        (this.blocks[Number(i)] ?? [])
          .map(
            (line) =>
              indent +
              line
                .replaceAll("{N2}", String(indent.length + 2))
                .replaceAll("{N}", String(indent.length)),
          )
          .join("\n"),
      )
      .replace(/(["']?)HELMX(\d+)X\1/g, (_, _q, i: string) => this.exprs[Number(i)] ?? "");
  }
}

const ENV_SECRET = `include "${HELM_CHART_NAME}.envSecret" .`;

export function toHelmChart(model: AppBlueprint, opts: HelmChartOptions): HelmChart {
  const p = new Placeholders();
  const services = k8sWorkloadServices(model);
  const byKey = new Map(services.map((s) => [s.key, s]));
  const objects = toKubernetesObjects(model, {
    files: opts.files,
    releaseVersion: opts.releaseVersion,
  });

  // ── values ───────────────────────────────────────────────────────────────────
  const images: Record<string, string> = {};
  for (const s of services) images[helmValuesKey(s.key)] = k8sImageRef(s, opts.releaseVersion);
  const values: Record<string, unknown> = {
    images,
    imagePullPolicy: "IfNotPresent",
    persistence: { storageClass: "", size: "10Gi", keep: true },
    existingSecret: "",
    env: {},
    ingress: { enabled: false, className: "", host: "", annotations: {}, tls: [] },
  };
  for (const s of services) {
    values[helmValuesKey(s.key)] = {
      ...(CORE_SERVICES.has(s.key) ? {} : { enabled: true }),
      resources: {},
    };
  }
  const valuesComments: Record<string, string> = {
    images:
      " Every image the chart runs. Backing services at their pinned upstream refs, ours at\n" +
      " this release. Point any of them at a mirror (ADR 0024).",
    persistence:
      " One ReadWriteOnce volume per data directory. Empty storageClass: the cluster\n" +
      " default (k3s: local-path). keep: the volumes survive `helm uninstall`.",
    existingSecret:
      " Use a Secret you manage (sealed-secrets, External Secrets, …) instead of the one the\n" +
      " chart renders. Under Argo CD or `helm template`, which can't read the cluster back,\n" +
      " set this or every secret in `env`, or the generated ones change on every render.",
    env:
      " Values for the env Secret, by variable name (see .env.template in deploy/k8s/base).\n" +
      " Unset ones keep their current value, or are generated on install: COUCHDB_PASSWORD\n" +
      " and the Garage tokens. S3_ACCESS_KEY / S3_SECRET_KEY are minted by the provisioning\n" +
      " Job; set them only for an external S3.",
    ingress:
      " An Ingress for the app (webapi + webui). The stack has no auth (ADR 0020): put it\n" +
      " on a network you trust.",
  };

  // ── the projected workloads, templated ───────────────────────────────────────
  const fileOf = (o: KubernetesObject) => o.metadata.labels?.["app.kubernetes.io/name"] ?? "";
  const templates = new Map<string, unknown[]>();
  for (const original of objects) {
    if (original.kind === "Namespace") continue;
    // A deep copy: the projection shares one labels object between an object's metadata
    // and its selectors, and the release labels must only go on the former.
    // Loosely typed from here on: placeholder keys carry `null`, which the emitted
    // KubernetesObject type rightly doesn't allow.
    const o = JSON.parse(JSON.stringify(original)) as Record<string, any> & {
      kind: string;
      metadata: Record<string, any>;
    };
    const key = fileOf(original);
    const s = byKey.get(key);
    if (!s) throw new Error(`projected ${o.kind} ${o.metadata.name} belongs to no service`);
    const vk = helmValuesKey(key);

    delete o.metadata.namespace;
    o.metadata.labels = {
      ...o.metadata.labels,
      [p.block([`{{- include "${HELM_CHART_NAME}.releaseLabels" . | nindent {N} }}`])]: null,
    };

    if (o.kind === "PersistentVolumeClaim") {
      o.metadata.annotations = {
        [p.block([
          "{{- if .Values.persistence.keep }}",
          "helm.sh/resource-policy: keep",
          "{{- end }}",
        ])]: null,
      };
      o.spec.resources.requests.storage = p.expr("{{ .Values.persistence.size | quote }}");
      o.spec[
        p.block([
          "{{- with .Values.persistence.storageClass }}",
          "storageClassName: {{ . | quote }}",
          "{{- end }}",
        ])
      ] = null;
    }

    if (o.kind === "Deployment") {
      const pod = o.spec.template.spec;
      for (const c of pod.containers as Array<Record<string, any>>) {
        c.image = p.expr(`{{ .Values.images.${vk} | quote }}`);
        c.imagePullPolicy = p.expr("{{ .Values.imagePullPolicy }}");
        for (const e of c.env ?? []) {
          if (e.valueFrom?.secretKeyRef?.name === K8S_ENV_SECRET) {
            e.valueFrom.secretKeyRef.name = p.expr(`{{ ${ENV_SECRET} }}`);
          }
        }
        if (c.envFrom) {
          c.envFrom = [
            // The provisioned S3 key first, so a key set explicitly in `env` wins.
            ...(key === "app" ? [{ secretRef: { name: HELM_S3_SECRET, optional: true } }] : []),
            { secretRef: { name: p.expr(`{{ ${ENV_SECRET} }}`) } },
          ];
        }
        c[
          p.block([
            `{{- with .Values.${vk}.resources }}`,
            "resources:",
            "  {{- toYaml . | nindent {N2} }}",
            "{{- end }}",
          ])
        ] = null;
      }
      // Roll the pods when what the env Secret is made from changes. Not a hash of the
      // rendered Secret: on install that render generates values afresh, so it would
      // differ from the stored Secret and roll every pod on the first upgrade (and on
      // every sync under Argo CD). Generated values never change once stored.
      o.spec.template.metadata.annotations = {
        "checksum/env": p.expr(
          "{{ list .Values.env .Values.existingSecret | toJson | sha256sum }}",
        ),
      };
    }

    const list = templates.get(key) ?? [];
    list.push(o);
    templates.set(key, list);
  }

  const out: HelmTemplate[] = [...templates.entries()].map(([key, objs]) => ({
    name: `${key}.yaml`,
    objects: objs,
    ...(CORE_SERVICES.has(key) ? {} : { condition: `.Values.${helmValuesKey(key)}.enabled` }),
  }));

  out.push({
    name: "env-secret.yaml",
    objects: [envSecret(model, p)],
    condition: "not .Values.existingSecret",
  });
  // Provisioning is Garage's bootstrap (CouchDB's databases the webapi makes itself), so
  // it runs only where the chart runs Garage.
  out.push({
    name: "provision.yaml",
    objects: provisionObjects(p, byKey),
    condition: ".Values.garage.enabled",
  });
  const app = byKey.get("app");
  if (app)
    out.push({
      name: "ingress.yaml",
      objects: [ingress(p, app)],
      condition: ".Values.ingress.enabled",
    });

  return {
    chart: {
      apiVersion: "v2",
      name: HELM_CHART_NAME,
      description: `${model.identity.title} — self-hosted history for Claude Code sessions: CouchDB, Garage (S3), Fossil, Meilisearch and the app.`,
      type: "application",
      version: opts.releaseVersion,
      appVersion: opts.releaseVersion,
      keywords: ["claude", "claude-code", "transcripts", "couchdb", "s3", "self-hosted"],
    },
    values,
    valuesComments,
    templates: out,
    rawTemplates: {
      "_helpers.tpl": helpers(),
      "NOTES.txt": notes(services),
    },
    render: (text) => p.render(text),
  };
}

/**
 * The env Secret: every key the base's `.env.template` carries. Precedence per key:
 * `values.env`, then what the cluster already holds (`lookup`), then a generated value
 * or the compose default.
 */
function envSecret(model: AppBlueprint, p: Placeholders): Record<string, unknown> {
  const lines = [
    `{{- $current := (lookup "v1" "Secret" .Release.Namespace "${K8S_ENV_SECRET}").data | default dict }}`,
  ];
  for (const { name, fallback } of k8sSecretKeys(model)) {
    const given = `(index .Values.env "${name}")`;
    if (S3_KEYS.has(name)) {
      lines.push(
        `{{- with ${given} }}`,
        `${name}: {{ . | toString | b64enc | quote }}`,
        "{{- end }}",
      );
      continue;
    }
    const bytes = HELM_GENERATED_SECRETS[name];
    const otherwise = bytes
      ? `(randAlphaNum 64 | sha256sum | trunc ${bytes * 2})`
      : JSON.stringify(fallback ?? "");
    lines.push(
      `${name}: {{ ${given} | default (index $current "${name}" | default "" | b64dec) | default ${otherwise} | toString | b64enc | quote }}`,
    );
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: K8S_ENV_SECRET,
      labels: {
        "app.kubernetes.io/part-of": K8S_PART_OF,
        [p.block([`{{- include "${HELM_CHART_NAME}.releaseLabels" . | nindent {N} }}`])]: null,
      },
    },
    type: "Opaque",
    data: { [p.block(lines)]: null },
  };
}

/**
 * The provisioning hook: a ServiceAccount allowed to create the S3 Secret and restart
 * the app, and a Job that runs `claude-transcripts provision` from the app image against
 * the in-cluster services, then hands the S3 key it minted to the cluster. Idempotent,
 * so it runs after every install and upgrade (and every Argo CD sync, as a PostSync hook).
 */
function provisionObjects(p: Placeholders, byKey: Map<string, ServiceDef>): unknown[] {
  const name = `${HELM_CHART_NAME}-provision`;
  const labels = {
    "app.kubernetes.io/name": "provision",
    "app.kubernetes.io/part-of": K8S_PART_OF,
    [p.block([`{{- include "${HELM_CHART_NAME}.releaseLabels" . | nindent {N} }}`])]: null,
  };
  const couch = byKey.get("couchdb")?.ports?.[0]?.internal;
  const garageAdmin = byKey
    .get("garage")
    ?.ports?.find((x) => x.hostEnv === "GARAGE_ADMIN_PORT")?.internal;
  if (!couch || !garageAdmin) throw new Error("provisioning needs the couchdb and garage services");

  return [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name, labels } },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name, labels },
      rules: [
        // `create` can't be narrowed by name; get/patch can.
        { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
        {
          apiGroups: [""],
          resources: ["secrets"],
          resourceNames: [HELM_S3_SECRET],
          verbs: ["get", "patch"],
        },
        {
          apiGroups: ["apps"],
          resources: ["deployments"],
          resourceNames: ["app"],
          verbs: ["get", "patch"],
        },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name, labels },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
      subjects: [{ kind: "ServiceAccount", name }],
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, labels },
      data: {
        [p.block(["provision.ts: |", '  {{- .Files.Get "files/provision.ts" | nindent {N2} }}'])]:
          null,
      },
    },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name,
        labels,
        annotations: {
          "helm.sh/hook": "post-install,post-upgrade",
          "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
        },
      },
      spec: {
        // Garage and CouchDB may still be starting: retry with backoff for ~10 minutes.
        backoffLimit: 8,
        activeDeadlineSeconds: 900,
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: name,
            restartPolicy: "Never",
            containers: [
              {
                name: "provision",
                image: p.expr("{{ .Values.images.app | quote }}"),
                imagePullPolicy: p.expr("{{ .Values.imagePullPolicy }}"),
                command: ["bun", "/provision/provision.ts"],
                env: [
                  { name: "COUCHDB_URL", value: `http://couchdb:${couch}` },
                  { name: "GARAGE_ADMIN_URL", value: `http://garage:${garageAdmin}` },
                  { name: "CT_S3_SECRET", value: HELM_S3_SECRET },
                  { name: "CT_APP_DEPLOYMENT", value: "app" },
                ],
                envFrom: [
                  { secretRef: { name: HELM_S3_SECRET, optional: true } },
                  { secretRef: { name: p.expr(`{{ ${ENV_SECRET} }}`) } },
                ],
                volumeMounts: [{ name: "provision", mountPath: "/provision", readOnly: true }],
              },
            ],
            volumes: [{ name: "provision", configMap: { name } }],
          },
        },
      },
    },
  ];
}

function ingress(p: Placeholders, app: ServiceDef): Record<string, unknown> {
  const port = app.ports?.[0]?.internal ?? 7650;
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: "app",
      labels: {
        "app.kubernetes.io/name": "app",
        "app.kubernetes.io/part-of": K8S_PART_OF,
        [p.block([`{{- include "${HELM_CHART_NAME}.releaseLabels" . | nindent {N} }}`])]: null,
      },
      [p.block([
        "{{- with .Values.ingress.annotations }}",
        "annotations:",
        "  {{- toYaml . | nindent {N2} }}",
        "{{- end }}",
      ])]: null,
    },
    spec: {
      [p.block([
        "{{- with .Values.ingress.className }}",
        "ingressClassName: {{ . | quote }}",
        "{{- end }}",
        "{{- with .Values.ingress.tls }}",
        "tls:",
        "  {{- toYaml . | nindent {N2} }}",
        "{{- end }}",
      ])]: null,
      rules: [
        {
          host: p.expr("{{ .Values.ingress.host | quote }}"),
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name: "app", port: { number: port } } },
              },
            ],
          },
        },
      ],
    },
  };
}

function helpers(): string {
  return `{{/*
GENERATED from the blueprint by scripts/gen-helm.ts — see deploy/helm/README.md.
*/}}

{{/* The env Secret every workload reads: the chart's, or one you manage (existingSecret). */}}
{{- define "${HELM_CHART_NAME}.envSecret" -}}
{{- .Values.existingSecret | default "${K8S_ENV_SECRET}" -}}
{{- end }}

{{/*
Labels for this release, on object metadata only. Selectors keep the projection's
app.kubernetes.io/name + part-of, which are immutable once a Deployment exists.
*/}}
{{- define "${HELM_CHART_NAME}.releaseLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}
`;
}

function notes(services: ServiceDef[]): string {
  const forwards = services
    .filter((s) => s.ports?.length)
    .map((s) => {
      const ports = (s.ports ?? []).map((x) => `${x.defaultHost}:${x.internal}`).join(" ");
      return `  kubectl -n {{ .Release.Namespace }} port-forward svc/${s.key} ${ports} &`;
    })
    .join("\n");
  return `Claude Transcripts {{ .Chart.AppVersion }} is installing in {{ .Release.Namespace }}.

The provisioning Job creates the databases, Garage's layout, bucket and key, then
restarts the app with the key. Watch it:

  kubectl -n {{ .Release.Namespace }} get pods -w

Nothing is exposed (the stack has no auth). Reach it on the ports the compose stack
uses on localhost, so the hook and CLI defaults work unchanged:

${forwards}

Then open http://127.0.0.1:7650/app/
{{- if .Values.ingress.enabled }}

Or through the Ingress: http://{{ .Values.ingress.host }}/app/
{{- end }}
`;
}
