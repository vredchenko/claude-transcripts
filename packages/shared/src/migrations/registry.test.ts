/**
 * Registry invariants.
 *
 * The view-only property is not a coincidence to be rediscovered later — `export` /
 * `import` depend on it (bundles.md), so it is asserted here. When the first
 * document-transforming migration lands, this test fails and points at the guard that
 * has to be taught about it.
 */
import { describe, expect, test } from "bun:test";
import { docTransformsBetween, latestVersion, MIGRATIONS } from "./registry";
import type { Migration } from "./types";

const noop = async () => {};

function fake(id: number, transformsDocs?: boolean): Migration {
  return { id, name: `m${id}`, up: noop, down: noop, transformsDocs };
}

describe("MIGRATIONS", () => {
  test("ids are unique and ascending", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("latestVersion is the highest id", () => {
    expect(latestVersion()).toBe(Math.max(...MIGRATIONS.map((m) => m.id)));
  });

  test("every migration is view-only — import's restore path depends on it", () => {
    const transforming = MIGRATIONS.filter((m) => m.transformsDocs === true).map((m) => m.name);
    expect(transforming).toEqual([]);
  });
});

describe("docTransformsBetween", () => {
  const registry = [fake(1), fake(2, true), fake(3), fake(4, true)];

  test("is empty for the real registry across its whole range", () => {
    expect(docTransformsBetween(0, latestVersion())).toEqual([]);
  });

  test("reports transforms inside the range, in order", () => {
    expect(docTransformsBetween(0, 4, registry)).toEqual([
      { id: 2, name: "m2" },
      { id: 4, name: "m4" },
    ]);
  });

  test("excludes the lower bound and includes the upper", () => {
    // `from` is the version the data already has, so its migration has run over it.
    expect(docTransformsBetween(2, 4, registry)).toEqual([{ id: 4, name: "m4" }]);
    expect(docTransformsBetween(2, 3, registry)).toEqual([]);
  });

  test("is empty when the range is empty or inverted", () => {
    expect(docTransformsBetween(4, 4, registry)).toEqual([]);
    expect(docTransformsBetween(4, 2, registry)).toEqual([]);
  });
});
