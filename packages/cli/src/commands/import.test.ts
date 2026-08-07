/**
 * `import`'s schema gate (bundles.md).
 *
 * The case worth guarding is the quiet one: a bundle from an *older* schema restoring
 * into a newer instance. That is safe while migrations only touch design docs — views
 * are derived, so CouchDB rebuilds them over the restored docs — and unsafe the moment
 * one reshapes documents, because the target's marker already counts that migration as
 * applied and `migrate up` will never revisit the docs import just wrote.
 *
 * No migration in the real registry sets `transformsDocs`, so these tests inject a
 * registry that does. Without that the branch would first run in production.
 */
import { describe, expect, test } from "bun:test";
import { checkSchema, type SchemaRegistry } from "./import";

/** A build that knows 9 migrations, of which v8 reshapes documents. */
const withTransform: SchemaRegistry = {
  latest: 9,
  transformsBetween: (from, to) =>
    [{ id: 8, name: "rewrite-chunk-entries" }].filter((m) => m.id > from && m.id <= to),
};

/** A build that knows 9 migrations, all view-only — today's real shape. */
const viewOnly: SchemaRegistry = { latest: 9, transformsBetween: () => [] };

function joined(lines: string[] | null): string {
  return (lines ?? []).join("\n");
}

describe("checkSchema", () => {
  test("allows a bundle at the target's own schema version", () => {
    expect(checkSchema(7, { current: 7, latest: 9 }, viewOnly)).toBeNull();
  });

  test("allows an older bundle when the gap is view-only", () => {
    expect(checkSchema(3, { current: 7, latest: 9 }, viewOnly)).toBeNull();
  });

  test("allows an older bundle when the document transform sits outside the gap", () => {
    // v8 reshapes docs, but the target is still at v7 — it hasn't run yet.
    expect(checkSchema(3, { current: 7, latest: 9 }, withTransform)).toBeNull();
  });

  test("refuses an older bundle when a document transform sits inside the gap", () => {
    const out = joined(checkSchema(7, { current: 8, latest: 9 }, withTransform));
    expect(out).toContain("reshape documents");
    expect(out).toContain("v8 rewrite-chunk-entries");
    // The reason it refuses rather than migrating: the target already counts it applied.
    expect(out).toContain("`migrate up` would not touch it");
  });

  test("refuses a newer bundle and names `migrate up` when the build can reach it", () => {
    const out = joined(checkSchema(9, { current: 7, latest: 9 }, viewOnly));
    expect(out).toContain("migrate up");
    expect(out).not.toContain("upgrade claude-transcripts itself");
  });

  test("refuses a newer bundle and says upgrade the app when the build cannot reach it", () => {
    // The distinction that matters: `migrate up` would take this instance to v9 and
    // fail identically, so advising it would waste the user's time.
    const out = joined(checkSchema(12, { current: 7, latest: 9 }, viewOnly));
    expect(out).toContain("upgrade claude-transcripts itself");
    expect(out).toContain("only knows schema v9");
  });

  test("refuses when the CLI's registry is older than the instance's", () => {
    // Part of the gap is invisible to this build, so "view-only" would be a guess.
    const out = joined(checkSchema(3, { current: 11, latest: 12 }, viewOnly));
    expect(out).toContain("upgrade the CLI");
    expect(out).toContain("can't tell whether v4–v11 reshape documents");
  });

  test("treats a pristine target as a real version, not a missing one", () => {
    // v0 is a genuine state (nothing applied yet); a v1 bundle is ahead of it.
    const out = joined(checkSchema(1, { current: 0, latest: 7 }, viewOnly));
    expect(out).toContain("this instance is at v0");
  });
});
