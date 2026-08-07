/**
 * `claude-transcripts import` — restore a bundle into an instance (bundles.md).
 *
 *   claude-transcripts import <dir> [--dry-run] [--no-blobs] [--webapi URL]
 *
 * The other half of the round-trip: dump an instance, tear it down, install clean,
 * restore. Writes go through `/api/ingest/*` like every other write
 * ([ADR 0016](../../../docs/design/decisions/0016-webapi-is-the-io-gateway.md)) —
 * import never touches CouchDB or S3 directly.
 *
 * Three properties it has to have:
 *
 * - **Verify before writing anything.** Manifest, format version and every checksum
 *   are checked up front, so a truncated bundle is refused rather than half-restored.
 * - **Idempotent.** Every doc carries its source `_id`, so a second import conflicts
 *   benignly instead of duplicating. Re-running after an interruption is the intended
 *   way to resume.
 * - **Refuse to guess.** A bundle from a *newer* schema than this instance is
 *   rejected: migrations only run forward, and inventing a backward one is how data
 *   gets corrupted. A bundle from an *older* schema is accepted only while the
 *   migrations in between are view-only — see {@link checkSchema}.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { docTransformsBetween, latestVersion } from "@claude-transcripts/shared";
import { putStream, setWebapiUrl, webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";
import {
  BUNDLE_FORMAT,
  type BundleManifest,
  bundlePaths,
  formatBytes,
  hashFile,
  readManifest,
} from "../lib/bundle";

/** Docs per ingest request. Large enough to be quick, small enough to stay bounded. */
const BATCH = 500;

function num(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${webapiUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`POST ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Where the target stands: the schema it has applied, and the newest its build knows. */
export interface TargetVersions {
  /** Migrations actually applied to this database (0 = pristine). */
  current: number;
  /** The highest migration the *instance's build* carries — its ceiling for `migrate up`. */
  latest: number;
}

/**
 * Read the target's schema position.
 *
 * Returns `null` when the webapi can't be reached or doesn't answer, which is a
 * different thing from a pristine instance reporting v0 — and import must not confuse
 * them, because "v0" would send the version comparison down a branch it has no evidence
 * for. Every write goes through this same webapi anyway, so failing here is only
 * failing earlier and more clearly.
 */
async function readTargetVersions(): Promise<TargetVersions | null> {
  try {
    const res = await fetch(`${webapiUrl()}/api/migrate/status`);
    if (!res.ok) return null;
    const s = (await res.json()) as { currentVersion?: number; latestVersion?: number };
    if (typeof s.currentVersion !== "number") return null;
    return { current: s.currentVersion, latest: s.latestVersion ?? s.currentVersion };
  } catch {
    return null;
  }
}

/** What {@link checkSchema} needs to know about the migrations this build carries. */
export interface SchemaRegistry {
  /** The newest schema this build knows — its ceiling for `migrate up`. */
  latest: number;
  /** Migrations in `(from, to]` that reshape documents rather than only design docs. */
  transformsBetween: (from: number, to: number) => { id: number; name: string }[];
}

const REAL_REGISTRY: SchemaRegistry = {
  latest: latestVersion(),
  transformsBetween: docTransformsBetween,
};

/**
 * Decide whether this bundle may be restored into this instance.
 *
 * Three cases, and the interesting one is not the obvious one:
 *
 * - **Bundle newer than the target.** Refuse — migrations only run forward. But *why*
 *   the target is behind changes the fix entirely: if its build knows the bundle's
 *   schema, the instance merely hasn't run `migrate up`; if its build has never heard of
 *   that version, no amount of `migrate up` will help and the app itself is too old.
 *   Telling someone to run the wrong one of those wastes their time and ends in the
 *   same refusal.
 *
 * - **Bundle older than the target.** Safe *while migrations stay view-only*, which is
 *   the case for every migration written so far: views are derived, so CouchDB rebuilds
 *   them over the restored docs and nothing needs migrating forward. A document
 *   transform in the gap breaks that, and breaks it silently — the target's marker
 *   already counts it as applied, so `migrate up` has nothing pending and the restored
 *   docs keep their old shape forever. Refuse instead, until import can replay a
 *   transform over just the docs it wrote.
 *
 * - **Equal.** Nothing to consider.
 *
 * Returns the lines to print on refusal, or `null` to proceed. `registry` is injected
 * so the document-transform branch can be exercised — no migration written so far sets
 * `transformsDocs`, which is exactly why that branch would otherwise go untested until
 * the day it first matters.
 */
export function checkSchema(
  bundleVersion: number,
  target: TargetVersions,
  registry: SchemaRegistry = REAL_REGISTRY,
): string[] | null {
  if (bundleVersion > target.current) {
    const gap =
      `import: bundle is from schema v${bundleVersion} but this instance is at ` +
      `v${target.current}.`;
    return bundleVersion <= target.latest
      ? [
          gap,
          "import: this instance is behind its own build — run `claude-transcripts migrate up`,",
          "import: then re-run.",
        ]
      : [
          gap,
          `import: this build only knows schema v${target.latest}, so \`migrate up\` cannot reach ` +
            `v${bundleVersion}.`,
          "import: upgrade claude-transcripts itself, then re-run.",
        ];
  }

  if (bundleVersion < target.current) {
    // The registry compiled into this CLI answers the doc-transform question. Lockstep
    // versioning (ADR 0023) means it normally matches the instance's — but if the
    // instance knows migrations this build doesn't, part of the gap is invisible here
    // and a confident "safe" would be a guess.
    if (target.latest > registry.latest) {
      return [
        `import: this instance's build knows schema v${target.latest}; this CLI only knows ` +
          `v${registry.latest}.`,
        `import: it can't tell whether v${bundleVersion + 1}–v${target.current} reshape documents.`,
        "import: upgrade the CLI to match the instance, then re-run.",
      ];
    }
    const transforms = registry.transformsBetween(bundleVersion, target.current);
    if (transforms.length) {
      return [
        `import: bundle is from schema v${bundleVersion} and this instance is at ` +
          `v${target.current}, and the migrations in between reshape documents:`,
        ...transforms.map((t) => `           • v${t.id} ${t.name}`),
        "import: restoring would leave this data in the older shape — the target already",
        "import: counts those migrations as applied, so `migrate up` would not touch it.",
        "import: import into an instance at the bundle's schema version instead.",
      ];
    }
  }

  return null;
}

/** Recompute every checksum in the manifest. Returns the paths that don't match. */
async function verifyChecksums(dir: string, manifest: BundleManifest): Promise<string[]> {
  const bad: string[] = [];
  for (const [rel, expected] of Object.entries(manifest.checksums)) {
    const path = join(dir, rel);
    if (!existsSync(path)) {
      bad.push(`${rel} (missing)`);
      continue;
    }
    if ((await hashFile(path)) !== expected) bad.push(`${rel} (checksum mismatch)`);
  }
  return bad;
}

/** Yield each line of a file without loading the whole thing. */
async function* readLines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of Bun.file(path).stream()) {
    carry += decoder.decode(chunk, { stream: true });
    let nl = carry.indexOf("\n");
    while (nl >= 0) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      if (line.trim()) yield line;
      nl = carry.indexOf("\n");
    }
  }
  if (carry.trim()) yield carry;
}

export async function runImport(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const dir = positionals[0];
  if (!dir) {
    console.error("import: a bundle directory is required — `import <dir>`");
    return 2;
  }
  const url = strOpt(options, "webapi");
  if (url) setWebapiUrl(url);
  const dryRun = options["dry-run"] === true;
  const withBlobs = options["no-blobs"] !== true;

  // ── Verify ─────────────────────────────────────────────────────────────────
  let manifest: BundleManifest;
  try {
    manifest = readManifest(dir);
  } catch (err) {
    console.error(`import: ${(err as Error).message}`);
    return 1;
  }

  console.log(`import: ${dir} → ${webapiUrl()}`);
  console.log(
    `  bundle   format ${manifest.format}, schema v${manifest.schemaVersion}, ` +
      `${num(manifest.counts.docs)} docs, ${manifest.counts.blobs} blobs`,
  );
  console.log(`  taken    ${manifest.createdAt} on ${manifest.source.hostname}`);

  // Asymmetric on purpose. A bundle outlives the release that wrote it — that is the
  // whole reason `format` is versioned separately from the app — so a newer CLI must
  // keep reading older layouts. Only a format from the future is unreadable.
  if (manifest.format > BUNDLE_FORMAT) {
    console.error(
      `import: bundle is format ${manifest.format} but this CLI reads up to ${BUNDLE_FORMAT}.`,
    );
    console.error("import: upgrade claude-transcripts, then re-run.");
    return 1;
  }

  const target = await readTargetVersions();
  if (!target) {
    console.error(`import: can't read the schema version from the webapi at ${webapiUrl()}.`);
    console.error("import: check it is running, provisioned, and that the URL is the webapi's");
    console.error("import: and not a backing service's (set --webapi or $CT_WEBAPI_URL).");
    return 1;
  }

  const refusal = checkSchema(manifest.schemaVersion, target);
  if (refusal) {
    for (const line of refusal) console.error(line);
    return 1;
  }
  if (manifest.schemaVersion < target.current) {
    console.log(
      `  schema   v${manifest.schemaVersion} → v${target.current} (view-only migrations in`,
    );
    console.log("           between; CouchDB rebuilds views over the restored docs)");
  }

  process.stdout.write("  verify   checksums… ");
  const bad = await verifyChecksums(dir, manifest);
  if (bad.length) {
    console.log("FAILED");
    for (const b of bad.slice(0, 5)) console.error(`    ! ${b}`);
    console.error("import: bundle is incomplete or corrupted — nothing was written.");
    return 1;
  }
  console.log(`ok (${Object.keys(manifest.checksums).length} files)`);

  if (dryRun) {
    console.log("import: --dry-run — bundle is valid; nothing written.");
    return 0;
  }

  // ── Docs ───────────────────────────────────────────────────────────────────
  const paths = bundlePaths(dir);
  const events: Record<string, unknown>[] = [];
  const chunks: Record<string, unknown>[] = [];
  let summaries = 0;
  let inserted = 0;

  const flushEvents = async () => {
    if (!events.length) return;
    const res = await postJson("/api/ingest/events", { docs: events.splice(0, events.length) });
    inserted += res.inserted ?? 0;
  };
  const flushChunks = async () => {
    if (!chunks.length) return;
    const res = await postJson("/api/ingest/chunks", { docs: chunks.splice(0, chunks.length) });
    inserted += res.inserted ?? 0;
  };

  for await (const line of readLines(paths.docs)) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line);
    } catch {
      continue; // a malformed line can't be restored, and the checksum already passed
    }
    switch (doc.type) {
      case "summary":
        await postJson("/api/ingest/summary", doc);
        summaries++;
        break;
      case "event":
        events.push(doc);
        if (events.length >= BATCH) await flushEvents();
        break;
      case "chunk":
        chunks.push(doc);
        if (chunks.length >= BATCH) await flushChunks();
        break;
    }
  }
  await flushEvents();
  await flushChunks();
  console.log(`  docs     ${num(summaries)} summaries, ${num(inserted)} events+chunks written`);

  // ── Blobs ──────────────────────────────────────────────────────────────────
  let blobs = 0;
  let blobBytes = 0;
  let skipped = 0;
  if (withBlobs && existsSync(paths.blobs)) {
    for (const rel of Object.keys(manifest.checksums)) {
      if (!rel.startsWith("blobs/")) continue;
      const [, sessionId, name] = rel.split("/");
      if (!sessionId || !name) continue;
      // Only the transcript has an ingest endpoint. summary.json is a convenience copy
      // of a doc we've already restored to CouchDB, and nothing reads it back.
      if (name !== "transcript.jsonl") {
        skipped++;
        continue;
      }
      const path = join(dir, rel);
      await putStream(`/api/ingest/${sessionId}/transcript`, path, "application/x-ndjson");
      blobs++;
      blobBytes += statSync(path).size;
    }
    console.log(
      `  blobs    ${blobs} restored, ${formatBytes(blobBytes)}${skipped ? ` (${skipped} skipped)` : ""}`,
    );
  } else {
    console.log(`  blobs    skipped${withBlobs ? " (none in bundle)" : " (--no-blobs)"}`);
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  // The `_changes` follower picks these writes up as they land, but a bulk restore is
  // exactly when it's worth being certain rather than probably-fine.
  process.stdout.write("  search   rebuilding… ");
  try {
    const res = await postJson("/api/search/reindex", {});
    console.log(
      res.enabled
        ? `${num(res.sessions?.indexed ?? 0)} sessions, ${num(res.turns?.indexed ?? 0)} turns`
        : "disabled",
    );
  } catch (err) {
    console.log(`skipped (${(err as Error).message})`);
  }

  if (manifest.missingBlobs?.length) {
    console.log(
      `  note     ${manifest.missingBlobs.length} session(s) had no transcript when exported`,
    );
  }
  console.log("import: done. Verify with `claude-transcripts sessions`.");
  return 0;
}
