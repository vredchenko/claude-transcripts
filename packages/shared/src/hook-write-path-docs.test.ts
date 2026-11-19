/**
 * The docs say what the code does: the hook writes only through the webapi (#288,
 * ADR 0016 amendment 2). This is the prose half of that guard — the code half is
 * `packages/cli/src/hook/no-store-access.test.ts` and the topology tests. A doc, skill,
 * plugin description or landing page that tells a reader the hook writes CouchDB or S3
 * directly, or shows a hook config with store blocks, fails here.
 *
 * Exempt, because they are records of what was true: the CHANGELOG, `rfcs/`, and the
 * superseded first amendment inside ADR 0016 itself.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

const ROOTS = [
  "docs",
  "hooks",
  "deploy",
  "site",
  "tests",
  "README.md",
  "CLAUDE.md",
  ".claude-plugin",
];
const EXEMPT = [/^CHANGELOG\.md$/, /^rfcs\//, /node_modules/, /^docs\/assets\//];

/** The prose a reader takes the write path from. */
function files(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(ROOT, rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(abs)) walk(join(rel, e));
    } else if (/\.(md|json|html)$/.test(rel) && !EXEMPT.some((r) => r.test(rel))) {
      out.push(rel);
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

/** ADR 0016 keeps its superseded amendment as history; only the text outside it counts. */
function current(rel: string): string {
  const text = readFileSync(join(ROOT, rel), "utf8");
  if (!rel.endsWith("0016-webapi-is-the-io-gateway.md")) return text;
  const start = text.indexOf("## Amendment: the hook is a second writer");
  const end = text.indexOf("## Amendment 2:");
  return start >= 0 && end > start ? text.slice(0, start) + text.slice(end) : text;
}

const CLAIMS: [RegExp, string][] = [
  [
    /hook[^.\n]{0,80}\b(writes?|logs?|records?)\b[^.\n]{0,60}\b(directly|straight)\b/i,
    "the hook writing a store directly",
  ],
  [/\b(writes?|logs?)\b[^.\n]{0,30}\b(directly|straight) to (CouchDB|S3)/i, "a direct store write"],
  [/hook[^.\n]{0,40}bypass(es)? the webapi/i, "the hook bypassing the webapi"],
  [/\bthe second writer\b/i, "the hook as a second writer"],
  [
    // ADR 0016 itself links to its superseded amendment, as history; nothing else should.
    /#amendment-the-hook-is-a-second-writer/,
    "a link to the superseded amendment as current",
  ],
  [/log every session to CouchDB/i, "the plugin logging to CouchDB"],
];

describe("docs describe the hook's write path as it is", () => {
  const corpus = files();

  test("the scan reaches the docs it guards", () => {
    for (const must of [
      "README.md",
      "CLAUDE.md",
      "docs/reference/hook.md",
      "hooks/.claude-plugin/plugin.json",
    ]) {
      expect(corpus).toContain(must);
    }
  });

  test("no published doc says the hook writes around the webapi", () => {
    const found: string[] = [];
    for (const rel of corpus) {
      const text = current(rel);
      for (const [re, what] of CLAIMS) {
        if (rel.includes("0016-webapi") && re.source.includes("#amendment")) continue;
        const m = text.match(re);
        if (m) found.push(`${rel}: ${what} — "${m[0].slice(0, 90)}"`);
      }
    }
    expect(found).toEqual([]);
  });

  test("no hook config example carries store blocks", () => {
    // The hook config is `{ webapi, mirrors?, features, system, recall }`; a `"couch"` or
    // `"blob"` key in a config example teaches a shape the hook ignores.
    const found = ["docs/start/hook-setup.md", "docs/operate/mirrors.md", "docs/reference/hook.md"]
      .filter((rel) => /"(couch|blob)"\s*:\s*\{/.test(current(rel)))
      .map((rel) => relative(ROOT, join(ROOT, rel)));
    expect(found).toEqual([]);
  });

  test("the guard bites", () => {
    const samples = [
      "The hook writes to CouchDB and S3 directly.",
      "it writes directly to CouchDB",
      "the hook bypasses the webapi",
      "the hook — the second writer",
      "[x](0016.md#amendment-the-hook-is-a-second-writer)",
      "log every session to CouchDB + S3",
    ];
    for (const [re] of CLAIMS) expect(samples.some((s) => re.test(s))).toBe(true);
    expect(CLAIMS.some(([re]) => re.test("the hook writes through the webapi into CouchDB"))).toBe(
      false,
    );
  });
});
