/**
 * The hook writes only through the webapi (#288, ADR 0016). This is the static half of
 * that guarantee: nothing the hook runs may open a store client, build a store URL or
 * read a store credential — so a "quick fix" that writes CouchDB directly fails here,
 * not in a user's silently half-recorded history.
 *
 * The rest of the CLI is held to the same rule, except for the admin paths that
 * provision a local stack and so must reach the stores by design.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

/**
 * What reaching a store directly looks like in this codebase, tested line by line. A
 * CouchDB endpoint under the webapi's read-only `/api/couch` proxy is a read through the
 * gateway, which is allowed.
 */
const STORE_ACCESS: [(line: string) => boolean, string][] = [
  [(l) => /\bS3Client\b/.test(l), "an S3 client"],
  [(l) => /\bresolveCouchUrl\b/.test(l), "a CouchDB URL"],
  [
    (l) => /\b(COUCHDB|S3)_(URL|HOST|PORT|USER|PASSWORD|ENDPOINT|ACCESS_KEY|SECRET_KEY)\b/.test(l),
    "a store env var",
  ],
  [
    (l) => /\/_(all_docs|bulk_docs|find|changes)\b/.test(l) && !l.includes("/api/couch/"),
    "a raw CouchDB endpoint",
  ],
  [(l) => /\bconfig\.(couch|blob)\b/.test(l), "the legacy store blocks of the hook config"],
];

/** Admin paths that provision a local stack: they own the stores, by design. */
const ALLOWED = new Set([
  "lib/provision.ts",
  "lib/instance-env.ts",
  "lib/assets.generated.ts",
  "lib/compose.ts",
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** Comments may say what the code no longer does; only code counts. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(files: string[]): string[] {
  const found: string[] = [];
  for (const path of files) {
    const lines = code(path).split("\n");
    for (const [matches, what] of STORE_ACCESS) {
      if (lines.some(matches)) found.push(`${relative(SRC, path)}: ${what}`);
    }
  }
  return found;
}

describe("no direct store access", () => {
  test("the hook reaches no store — every write goes through the webapi", () => {
    expect(offenders(sources(join(SRC, "hook")))).toEqual([]);
  });

  test("the statusline renders from /tmp state only, and names no store", () => {
    expect(
      offenders([join(SRC, "lib", "statusline.ts"), join(SRC, "commands", "statusline.ts")]),
    ).toEqual([]);
  });

  test("outside the allow-listed admin paths, no CLI code reaches a store", () => {
    const rest = sources(SRC).filter((p) => !ALLOWED.has(relative(SRC, p)));
    expect(offenders(rest)).toEqual([]);
  });

  test("the guard itself bites", () => {
    // A guard that matches nothing passes forever; pin that each pattern can fire.
    const samples = [
      "new S3Client({})",
      "resolveCouchUrl(env)",
      "env.COUCHDB_URL",
      'fetch(couch + "/sessions/_all_docs")',
      "config.couch.url",
    ];
    for (const [matches] of STORE_ACCESS) expect(samples.some(matches)).toBe(true);
    // …and a read through the gateway's proxy is not store access.
    expect(STORE_ACCESS.some(([m]) => m('fetch(base + "/api/couch/sessions/_all_docs")'))).toBe(
      false,
    );
  });
});
