/**
 * The omnibus image (deploy/omnibus/Dockerfile) pins every component in its own ARGs,
 * because a Dockerfile can't read the blueprint. These checks hold those pins to the
 * blueprint's `defaultTag`s, so bumping a service for the compose stack without the
 * omnibus (or the reverse) fails here instead of shipping two different versions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICES } from "./services";

const DEPLOY = join(import.meta.dir, "..", "..", "..", "..", "deploy");
const DOCKERFILE = readFileSync(join(DEPLOY, "omnibus", "Dockerfile"), "utf8");

function arg(name: string): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(DOCKERFILE)?.[1];
}

function tag(key: string): string | undefined {
  return SERVICES.find((s) => s.key === key)?.image?.defaultTag;
}

describe("omnibus pins", () => {
  for (const [argName, key] of [
    ["COUCHDB_IMAGE", "couchdb"],
    ["GARAGE_IMAGE", "garage"],
    ["GARAGE_UI_IMAGE", "garage-ui"],
    ["MEILI_UI_IMAGE", "meilisearch-ui"],
  ] as const) {
    test(`${argName} is the ${key} service's image at its tag, by digest`, () => {
      const service = SERVICES.find((s) => s.key === key);
      expect(arg(argName)).toMatch(
        new RegExp(`^${service?.image?.upstream}:${tag(key)}@sha256:[0-9a-f]{64}$`),
      );
    });
  }

  test("Meilisearch is a release of the series the blueprint's tag names", () => {
    // The tag is a minor series (v1.10); the release binary needs an exact version.
    expect(`v${arg("MEILI_VERSION")}`.startsWith(`${tag("meilisearch")}.`)).toBe(true);
  });

  test("the default Fossil image is the local build of the blueprint's version", () => {
    expect(arg("FOSSIL_IMAGE")).toBe(`claude-transcripts-fossil:${tag("fossil")}-local`);
  });
});
