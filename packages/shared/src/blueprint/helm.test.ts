import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { buildAppBlueprint } from "./build";
import { HELM_GENERATED_SECRETS, HELM_S3_SECRET, helmValuesKey, toHelmChart } from "./helm";
import { k8sImageRef, k8sSecretKeys, k8sWorkloadServices } from "./k8s";
import type { AppConfigFile } from "./types";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "s" } },
  s3: { buckets: { sessions: "s" } },
  features: {},
  servicesMenu: {},
};
const model = buildAppBlueprint(CONFIG, {});
const chart = toHelmChart(model, {
  files: { "./garage.toml": 'metadata_dir = "/m"\n' },
  releaseVersion: "1.2.3",
});
const yaml = (o: unknown) => stringify(o, { aliasDuplicateObjects: false, lineWidth: 0 });
const rendered = Object.fromEntries(
  chart.templates.map((t) => [t.name, chart.render(t.objects.map(yaml).join("---\n"))]),
);
const all = Object.values(rendered).join("\n");

describe("helm chart", () => {
  test("is versioned with the release", () => {
    expect(chart.chart.version).toBe("1.2.3");
    expect(chart.chart.appVersion).toBe("1.2.3");
  });

  test("every placeholder is rendered", () => {
    expect(all).not.toMatch(/HELM[XB]\d+[XB]/);
  });

  test("one template per workload, the optional ones behind <service>.enabled", () => {
    for (const s of k8sWorkloadServices(model)) {
      const t = chart.templates.find((x) => x.name === `${s.key}.yaml`);
      expect(t).toBeDefined();
      const core = s.key === "app" || s.key === "couchdb";
      expect(t?.condition).toBe(core ? undefined : `.Values.${helmValuesKey(s.key)}.enabled`);
      const values = chart.values[helmValuesKey(s.key)] as Record<string, unknown>;
      expect("enabled" in values).toBe(!core);
    }
  });

  test("images default to the kustomize base's refs", () => {
    const images = chart.values.images as Record<string, string>;
    for (const s of k8sWorkloadServices(model)) {
      expect(images[helmValuesKey(s.key)]).toBe(k8sImageRef(s, "1.2.3"));
      expect(rendered[`${s.key}.yaml`]).toContain(
        `image: {{ .Values.images.${helmValuesKey(s.key)} | quote }}`,
      );
    }
  });

  test("selectors keep only the projection's labels, which are immutable once deployed", () => {
    for (const t of chart.templates) {
      for (const o of t.objects as Array<Record<string, any>>) {
        if (o.kind !== "Deployment") continue;
        expect(Object.keys(o.spec.selector.matchLabels).sort()).toEqual([
          "app.kubernetes.io/name",
          "app.kubernetes.io/part-of",
        ]);
        expect(o.spec.template.metadata.labels).toEqual(o.spec.selector.matchLabels);
      }
    }
  });

  test("a block renders at its key's indentation", () => {
    expect(rendered["couchdb.yaml"]).toMatch(
      /\n {4}\{\{- include "claude-transcripts\.releaseLabels" \. \| nindent 4 \}\}\n/,
    );
    expect(rendered["couchdb.yaml"]).toContain(
      "          resources:\n            {{- toYaml . | nindent 12 }}",
    );
  });

  test("pods roll when the Secret's inputs change, not on every render", () => {
    expect(rendered["app.yaml"]).toContain(
      "checksum/env: {{ list .Values.env .Values.existingSecret | toJson | sha256sum }}",
    );
    expect(all).not.toContain('env-secret.yaml") . | sha256sum');
  });

  test("volumes survive uninstall unless told otherwise", () => {
    expect(rendered["couchdb.yaml"]).toContain("helm.sh/resource-policy: keep");
    expect((chart.values.persistence as { keep: boolean }).keep).toBe(true);
  });
});

describe("env Secret", () => {
  const secret = rendered["env-secret.yaml"] ?? "";

  test("carries every key the kustomize base's .env.template does", () => {
    for (const { name } of k8sSecretKeys(model)) expect(secret).toContain(name);
  });

  test("keeps what the cluster holds, and generates only what it must", () => {
    expect(secret).toContain('lookup "v1" "Secret" .Release.Namespace "claude-transcripts-env"');
    for (const [name, bytes] of Object.entries(HELM_GENERATED_SECRETS)) {
      const line = secret.split("\n").find((l) => l.trimStart().startsWith(`${name}:`));
      expect(line).toContain(`(index $current "${name}"`);
      expect(line).toContain(`sha256sum | trunc ${bytes * 2}`);
    }
  });

  test("leaves the S3 key to the provisioning Job unless set explicitly", () => {
    expect(secret).toContain('{{- with (index .Values.env "S3_ACCESS_KEY") }}');
    expect(rendered["app.yaml"]).toContain(`name: ${HELM_S3_SECRET}`);
  });

  test("is not rendered when an existing Secret is named", () => {
    const t = chart.templates.find((x) => x.name === "env-secret.yaml");
    expect(t?.condition).toBe("not .Values.existingSecret");
  });
});

describe("provisioning", () => {
  const job = rendered["provision.yaml"] ?? "";

  test("is a post-install/upgrade hook that runs the CLI's provision from the app image", () => {
    expect(job).toContain("helm.sh/hook: post-install,post-upgrade");
    expect(job).toContain("image: {{ .Values.images.app | quote }}");
    expect(job).toContain('{{- .Files.Get "files/provision.ts" | nindent');
  });

  test("reaches Garage's admin API and CouchDB by their in-cluster names and ports", () => {
    const garage = model.services.find((s) => s.key === "garage");
    const admin = garage?.ports?.find((x) => x.hostEnv === "GARAGE_ADMIN_PORT")?.internal;
    expect(job).toContain(`value: http://garage:${admin}`);
    const couch = model.services.find((s) => s.key === "couchdb")?.ports?.[0]?.internal;
    expect(job).toContain(`value: http://couchdb:${couch}`);
  });

  test("runs only where the chart runs Garage", () => {
    expect(chart.templates.find((x) => x.name === "provision.yaml")?.condition).toBe(
      ".Values.garage.enabled",
    );
  });
});
