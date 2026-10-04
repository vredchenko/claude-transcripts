/**
 * Images we build from source (`image.build`) rather than mirror — today, Fossil.
 *
 * The version lives in two places that can't share code: the model's `defaultTag`
 * (what compose, Kubernetes and the registry call the image) and the Dockerfile's
 * `FOSSIL_VERSION` (what actually gets compiled). These checks hold them together, so
 * bumping one without the other fails here rather than shipping an image whose tag
 * lies about its contents.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAppBlueprint } from "./build";
import { k8sImageRef, toKubernetesObjects } from "./k8s";
import {
  toComposeEnv,
  toComposeOverrideObject,
  toImageBuildPlan,
  toMirrorPlan,
  toStoreEnv,
} from "./project";
import { SERVICES } from "./services";
import type { AppConfigFile } from "./types";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "s" } },
  s3: { buckets: { sessions: "s" } },
  features: {},
  servicesMenu: {},
};
const model = buildAppBlueprint(CONFIG, {});
const DEPLOY = join(import.meta.dir, "..", "..", "..", "..", "deploy");
const built = SERVICES.filter((s) => s.image?.build);

describe("built images", () => {
  test("fossil is one", () => {
    expect(built.map((s) => s.key)).toContain("fossil");
  });

  test("an image is either mirrored or built, never both", () => {
    for (const s of built) expect(s.image?.upstream).toBeUndefined();
  });

  for (const s of built) {
    test(`${s.key}: the Dockerfile builds the version the tag names`, () => {
      const dockerfile = readFileSync(
        join(DEPLOY, s.image?.build?.context ?? "", "Dockerfile"),
        "utf8",
      );
      const version = /^ARG \w+_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
      expect(version).toBe(s.image?.defaultTag);
    });
  }
});

describe("projections", () => {
  test("the build plan names the image the way the mirror plan would", () => {
    expect(toImageBuildPlan(model)).toContainEqual({
      context: "./fossil",
      dest: "claude-transcripts-fossil:2.28",
    });
    const mirrored = new Set(toMirrorPlan(model).map((p) => p.dest));
    for (const p of toImageBuildPlan(model)) expect(mirrored.has(p.dest)).toBe(false);
  });

  test("the upstream override builds it locally rather than pulling", () => {
    const svc = (toComposeOverrideObject(model).services as Record<string, unknown>).fossil;
    expect(svc).toEqual({
      image: `claude-transcripts-fossil:\${FOSSIL_TAG:-2.28}-local`,
      build: { context: "./fossil" },
    });
  });

  test("Kubernetes pulls the published build at its pinned tag, not the app's release", () => {
    const fossil = model.services.find((s) => s.key === "fossil");
    if (!fossil) throw new Error("no fossil service");
    expect(k8sImageRef(fossil, "9.9.9")).toBe("ghcr.io/vredchenko/claude-transcripts-fossil:2.28");
  });
});

describe("fossil repository name", () => {
  test("named like the database and bucket by default", () => {
    expect(model.stores.repositories.sessions).toBe("claude-transcripts-sessions");
  });

  test("config wins, and a config that predates the key keeps the default", () => {
    const named = buildAppBlueprint(
      { ...CONFIG, fossil: { repositories: { sessions: "mine" } } },
      {},
    );
    expect(named.stores.repositories.sessions).toBe("mine");
    expect(CONFIG.fossil).toBeUndefined();
  });
});

describe("fossil readiness", () => {
  test("Kubernetes probes the port, since an empty Fossil 404s every path", () => {
    const objects = toKubernetesObjects(model, {
      files: { "./garage.toml": "" },
      releaseVersion: "1.2.3",
    });
    const dep = objects.find((o) => o.kind === "Deployment" && o.metadata.name === "fossil");
    if (!dep) throw new Error("no fossil Deployment");
    const c = (dep.spec as { template: { spec: { containers: Array<Record<string, unknown>> } } })
      .template.spec.containers[0];
    expect(c?.readinessProbe).toMatchObject({ tcpSocket: { port: 8080 } });
  });
});

describe("fossil seed", () => {
  test("the runners pass the configured repository names", () => {
    const named = buildAppBlueprint(
      { ...CONFIG, fossil: { repositories: { a: "one", b: "two" } } },
      {},
    );
    expect(toComposeEnv(named).FOSSIL_REPOSITORIES).toBe("claude-transcripts-sessions,one,two");
  });

  test("the compose fallback is the config template's default", () => {
    const template = JSON.parse(
      readFileSync(join(DEPLOY, "..", "config", "config.template.json"), "utf8"),
    ) as AppConfigFile;
    const fossil = SERVICES.find((s) => s.key === "fossil");
    expect(fossil?.containerEnv?.FOSSIL_REPOSITORIES).toBe(
      `\${FOSSIL_REPOSITORIES:-${toStoreEnv(buildAppBlueprint(template, {})).FOSSIL_REPOSITORIES}}`,
    );
  });
});

describe("fossil repository names", () => {
  test("a name Fossil couldn't serve fails at load, naming the key", () => {
    for (const bad of ["a.b", "a b", "-x", "a/b", ""]) {
      expect(() =>
        buildAppBlueprint({ ...CONFIG, fossil: { repositories: { sessions: bad } } }, {}),
      ).toThrow(/fossil\.repositories\.sessions/);
    }
  });
});
