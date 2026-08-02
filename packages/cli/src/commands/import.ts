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
 *   gets corrupted.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
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

async function targetSchemaVersion(): Promise<number> {
  try {
    const res = await fetch(`${webapiUrl()}/api/migrate/status`);
    if (!res.ok) return 0;
    const s = (await res.json()) as { currentVersion?: number };
    return s.currentVersion ?? 0;
  } catch {
    return 0;
  }
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

  if (manifest.format !== BUNDLE_FORMAT) {
    console.error(
      `import: bundle format ${manifest.format} but this CLI writes/reads ${BUNDLE_FORMAT}.`,
    );
    return 1;
  }

  const target = await targetSchemaVersion();
  if (manifest.schemaVersion > target) {
    // Forward-only: there is no honest way to interpret a schema we've never seen.
    console.error(
      `import: bundle is from schema v${manifest.schemaVersion} but this instance is at v${target}.\n` +
        "import: upgrade this instance first (`claude-transcripts migrate up`), then re-run.",
    );
    return 1;
  }
  if (manifest.schemaVersion < target) {
    console.log(`  schema   v${manifest.schemaVersion} → v${target} (target is newer; views are`);
    console.log("           rebuilt by migrations, so older data reads correctly)");
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
