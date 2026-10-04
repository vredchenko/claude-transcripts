/**
 * The Kubernetes base must stay a faithful projection of the same topology that
 * becomes the compose file — same images, same ports, same env names, same state.
 * These checks are what make "generated from the blueprint" a claim rather than a hope.
 */
import { describe, expect, test } from "bun:test";
import { buildAppBlueprint } from "./build";
import {
  K8S_ENV_SECRET,
  type KubernetesObject,
  k8sReleaseTag,
  k8sSecretKeys,
  k8sVolumeName,
  k8sWorkloadServices,
  parseEnvValue,
  toKubernetesObjects,
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

const model = buildAppBlueprint(CONFIG, {});
const FILES = { "./garage.toml": "replication_factor = 1\n" };
const RELEASE = "1.2.3";
const objects = toKubernetesObjects(model, { files: FILES, releaseVersion: RELEASE });
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

  test("the app image is pinned to the given release, and nothing runs on :latest", () => {
    const app = container(named("Deployment", "app")).image as string;
    expect(app).toEndWith(`/claude-transcripts-app:v${RELEASE}`);
    for (const s of k8sWorkloadServices(model)) {
      const image = container(named("Deployment", s.key)).image as string;
      if (s.image?.upstream) expect(image).toBe(`${s.image.upstream}:${s.image.defaultTag}`);
      expect(image).toMatch(/:[^/:]+$/); // an explicit tag
      expect(image).not.toContain("${");
      expect(image.endsWith(":latest")).toBe(false);
    }
    const other = toKubernetesObjects(model, { files: FILES, releaseVersion: "0.9.0" });
    const otherApp = other.find((o) => o.kind === "Deployment" && o.metadata.name === "app");
    if (!otherApp) throw new Error("no app Deployment");
    expect(container(otherApp).image).toEndWith(":v0.9.0");
  });

  test("the release version must be semver, so a bad input can't become a tag", () => {
    expect(k8sReleaseTag("0.3.3")).toBe("v0.3.3");
    expect(k8sReleaseTag("1.0.0-rc.1")).toBe("v1.0.0-rc.1");
    for (const bad of ["", "latest", "v0.3.3", "0.3"]) {
      expect(() => k8sReleaseTag(bad)).toThrow(/semver/);
      expect(() => toKubernetesObjects(model, { files: FILES, releaseVersion: bad })).toThrow();
    }
  });

  test("every workload pins imagePullPolicy, so none inherits the tag-dependent default", () => {
    for (const s of k8sWorkloadServices(model)) {
      expect(container(named("Deployment", s.key)).imagePullPolicy).toBe("IfNotPresent");
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
});
