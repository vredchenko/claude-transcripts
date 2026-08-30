/**
 * The Kubernetes base must stay a faithful projection of the same topology that
 * becomes the compose file — same images, same ports, same env names, same state.
 * These checks are what make "generated from the model" a claim rather than a hope.
 */
import { describe, expect, test } from "bun:test";
import { buildAppModel } from "./build";
import {
  K8S_ENV_SECRET,
  type KubernetesObject,
  k8sSecretKeys,
  k8sVolumeName,
  k8sWorkloadServices,
  parseEnvValue,
  toKubernetesObjects,
  toKustomization,
} from "./k8s";
import { toComposeObject } from "./project";
import type { AppConfigFile } from "./types";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "s" } },
  s3: { buckets: { sessions: "s" } },
  features: { s3Blobs: true, meilisearch: true },
  servicesMenu: {},
};

const model = buildAppModel(CONFIG, {});
const FILES = { "./garage.toml": "replication_factor = 1\n" };
const objects = toKubernetesObjects(model, { files: FILES });
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind);
const find = (kind: string, name: string) => ofKind(kind).find((o) => o.metadata.name === name);
function named(kind: string, name: string): KubernetesObject {
  const o = find(kind, name);
  if (!o) throw new Error(`no ${kind} named ${name}`);
  return o;
}
/** The single container of a Deployment (the projection never emits more than one). */
function container(dep: KubernetesObject): Record<string, unknown> {
  const c = (dep.spec as { template: { spec: { containers: Array<Record<string, unknown>> } } })
    .template.spec.containers[0];
  if (!c) throw new Error(`no container in ${dep.metadata.name}`);
  return c;
}

describe("parseEnvValue", () => {
  test("plain ref, ref with default, literal", () => {
    expect(parseEnvValue(`\${GARAGE_RPC_SECRET}`)).toEqual({
      kind: "ref",
      name: "GARAGE_RPC_SECRET",
    });
    expect(parseEnvValue(`\${COUCHDB_USER:-admin}`)).toEqual({
      kind: "ref",
      name: "COUCHDB_USER",
      fallback: "admin",
    });
    expect(parseEnvValue("http://garage:3903")).toEqual({
      kind: "literal",
      value: "http://garage:3903",
    });
  });
  test("a mixed value is refused rather than half-translated", () => {
    expect(() => parseEnvValue(`http://\${HOST}:3903`)).toThrow();
  });
});

describe("Kubernetes projection", () => {
  test("every compose service becomes exactly one Deployment, and vice versa", () => {
    const compose = Object.keys(toComposeObject(model).services).sort();
    const deployments = ofKind("Deployment")
      .map((o) => o.metadata.name)
      .sort();
    expect(deployments).toEqual(compose);
    expect(
      k8sWorkloadServices(model)
        .map((s) => s.key)
        .sort(),
    ).toEqual(compose);
  });

  test("every service with ports gets a ClusterIP Service on the same internal ports", () => {
    for (const s of k8sWorkloadServices(model)) {
      if (!s.ports?.length) {
        expect(find("Service", s.key)).toBeUndefined();
        continue;
      }
      const spec = named("Service", s.key).spec as {
        type?: string;
        ports: Array<{ port: number; targetPort: number }>;
      };
      expect(spec.type).toBeUndefined(); // ClusterIP by default — ADR 0020, no auth
      expect(spec.ports.map((p) => p.port).sort()).toEqual(s.ports.map((p) => p.internal).sort());
    }
  });

  test("images are the pinned upstream (mirror-free) refs, or our own release image", () => {
    for (const s of k8sWorkloadServices(model)) {
      const image = container(named("Deployment", s.key)).image as string;
      expect(image.endsWith(`:${s.image?.defaultTag}`)).toBe(true);
      if (s.image?.upstream) expect(image.startsWith(`${s.image.upstream}:`)).toBe(true);
      else expect(image).toContain(`/claude-transcripts-${s.image?.name}:`);
      expect(image).not.toContain("${");
    }
  });

  test("every writable volume is a PVC and its Deployment recreates rather than rolls", () => {
    for (const s of k8sWorkloadServices(model)) {
      const writable = (s.volumes ?? []).filter((v) => !v.readonly);
      for (const v of writable) {
        expect(find("PersistentVolumeClaim", k8sVolumeName(s.key, v.host))).toBeDefined();
      }
      const strategy = (named("Deployment", s.key).spec as { strategy?: { type: string } })
        .strategy;
      expect(strategy?.type).toBe(writable.length ? "Recreate" : undefined);
    }
  });

  test("read-only file mounts become ConfigMaps carrying the supplied content", () => {
    const cm = named("ConfigMap", "garage-config");
    expect((cm.data as Record<string, string>)["garage.toml"]).toBe(FILES["./garage.toml"]);
    expect(() => toKubernetesObjects(model, {})).toThrow(/garage\.toml/);
  });

  test("volume names are stable and readable", () => {
    expect(k8sVolumeName("couchdb", "./data/couchdb")).toBe("couchdb-data");
    expect(k8sVolumeName("garage", "./data/garage/meta")).toBe("garage-meta");
    expect(k8sVolumeName("meilisearch", "./data/meilisearch")).toBe("meilisearch-data");
  });

  test("every $VAR ref in containerEnv resolves to a key the .env template declares", () => {
    const declared = new Set(k8sSecretKeys(model).map((k) => k.name));
    for (const dep of ofKind("Deployment")) {
      const env = (container(dep).env ?? []) as unknown[];
      for (const e of env as Array<{
        valueFrom?: { secretKeyRef: { name: string; key: string } };
      }>) {
        if (!e.valueFrom) continue;
        expect(e.valueFrom.secretKeyRef.name).toBe(K8S_ENV_SECRET);
        expect(declared).toContain(e.valueFrom.secretKeyRef.key);
      }
    }
  });

  test("the app inherits the whole Secret (compose env_file) and pins in-cluster endpoints", () => {
    const c = container(named("Deployment", "app"));
    expect(c.envFrom).toEqual([{ secretRef: { name: K8S_ENV_SECRET } }]);
    const env = c.env as Array<{ name: string; value?: string }>;
    expect(env.find((e) => e.name === "COUCHDB_URL")?.value).toBe("http://couchdb:5984");
    expect(env.find((e) => e.name === "WEBAPI_PORT")?.value).toBe("7650");
    expect(c.readinessProbe).toMatchObject({ httpGet: { path: "/health", port: 7650 } });
    // and the template lists the app-facing secrets that Secret must carry
    const keys = k8sSecretKeys(model).map((k) => k.name);
    expect(keys).toEqual(
      expect.arrayContaining(["S3_ACCESS_KEY", "S3_SECRET_KEY", "GARAGE_RPC_SECRET"]),
    );
  });

  test("the .env template carries compose's defaults", () => {
    expect(k8sSecretKeys(model)).toContainEqual({ name: "COUCHDB_USER", fallback: "admin" });
    expect(k8sSecretKeys(model)).toContainEqual({ name: "GARAGE_RPC_SECRET" });
  });

  test("the kustomization references every file and builds the Secret from .env", () => {
    const k = toKustomization(["namespace.yaml", "app.yaml"]);
    expect(k.resources).toEqual(["namespace.yaml", "app.yaml"]);
    expect(k.secretGenerator[0]).toMatchObject({ name: K8S_ENV_SECRET, envs: [".env"] });
  });

  test("every object is namespaced and labelled part-of", () => {
    for (const o of objects) {
      expect(o.metadata.labels?.["app.kubernetes.io/part-of"]).toBe("claude-transcripts");
      if (o.kind !== "Namespace") expect(o.metadata.namespace).toBe("claude-transcripts");
    }
  });
});
