/**
 * `claude-transcripts export` — dump an instance to a portable bundle (bundles.md).
 *
 *   claude-transcripts export <dir> [--since ISO] [--session ID] [--no-blobs]
 *                                   [--webapi URL]
 *
 * Reads everything through the webapi's read-only proxies, like every other consumer
 * ([ADR 0016](../../../docs/design/decisions/0016-webapi-is-the-io-gateway.md)) — docs
 * via `/api/couch`, blobs via `/api/s3`.
 *
 * Two properties worth stating, because they shape the code:
 *
 * - **Nothing is buffered.** Docs are paged out of CouchDB and appended to
 *   `docs.ndjson` as they arrive; blobs stream object → file. On a real instance the
 *   blobs are ~11x everything else, so holding a bundle in memory would be the one
 *   thing guaranteed not to scale.
 * - **The manifest is written last.** It carries the checksums, so its presence is
 *   what marks a bundle complete — an interrupted export leaves something that import
 *   will refuse rather than half-restore.
 */

import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { loadAppConfig } from "../lib/app-config";
import { parseFlags, strOpt } from "../lib/args";
import {
  BUNDLE_FORMAT,
  type BundleManifest,
  bundlePaths,
  formatBytes,
  isExportableDoc,
  prepareBundleDir,
  restrictMode,
  streamToFile,
  toBundleDoc,
  writeManifest,
} from "../lib/bundle";

/** Docs per `_all_docs` page — bounded memory regardless of corpus size. */
const PAGE = 500;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${webapiUrl()}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Current schema version, so import knows whether to migrate the data forward. */
async function schemaVersion(): Promise<number> {
  try {
    const s = await getJson<{ currentVersion?: number }>("/api/migrate/status");
    return s.currentVersion ?? 0;
  } catch {
    return 0;
  }
}

async function appVersion(): Promise<string> {
  try {
    const h = await getJson<{ version?: string }>("/health");
    return h.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface AllDocsRow {
  id: string;
  doc?: Record<string, unknown> & { type?: string; session_id?: string; timestamp?: string };
}

export async function runExport(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const dir = positionals[0];
  if (!dir) {
    console.error("export: a destination directory is required — `export <dir>`");
    return 2;
  }
  const url = strOpt(options, "webapi");
  if (url) setWebapiUrl(url);

  const since = strOpt(options, "since") ?? null;
  const onlySession = strOpt(options, "session");
  const sessions = onlySession ? [onlySession] : null;
  const withBlobs = options["no-blobs"] !== true;

  const app = loadAppConfig();
  const db = app.couchdb.databases.sessions ?? "claude-transcripts-sessions";

  console.log(`export: ${webapiUrl()} → ${dir}`);
  prepareBundleDir(dir);
  const paths = bundlePaths(dir);

  // ── Docs ────────────────────────────────────────────────────────────────────
  const hasher = new Bun.CryptoHasher("sha256");
  const sink = Bun.file(paths.docs).writer();
  const sessionIds = new Set<string>();
  let docCount = 0;
  let skipped = 0;
  let startkey: string | undefined;

  try {
    for (;;) {
      const params = new URLSearchParams({
        include_docs: "true",
        limit: String(PAGE + 1), // one extra row tells us where the next page starts
      });
      if (startkey) params.set("startkey", JSON.stringify(startkey));
      const page = await getJson<{ rows: AllDocsRow[] }>(
        `/api/couch/${encodeURIComponent(db)}/_all_docs?${params}`,
      );
      const rows = page.rows ?? [];
      const batch = rows.slice(0, PAGE);
      if (!batch.length) break;

      for (const row of batch) {
        const doc = row.doc;
        if (!doc) continue;
        if (!isExportableDoc(row.id, doc.type)) {
          skipped++;
          continue;
        }
        const sid = doc.session_id;
        if (sessions && (!sid || !sessions.includes(sid))) continue;
        if (since && typeof doc.timestamp === "string" && doc.timestamp < since) continue;

        const line = `${JSON.stringify(toBundleDoc(doc))}\n`;
        hasher.update(line);
        sink.write(line);
        docCount++;
        if (sid) sessionIds.add(sid);
      }

      if (rows.length <= PAGE) break;
      startkey = rows[PAGE]?.id;
      if (!startkey) break;
    }
  } finally {
    await sink.end();
  }
  restrictMode(paths.docs);

  const checksums: Record<string, string> = {
    "docs.ndjson": `sha256:${hasher.digest("hex")}`,
  };
  console.log(
    `  docs    ${docCount} written, ${skipped} excluded (design docs, schema marker, checkpoint)`,
  );
  console.log(`  sessions ${sessionIds.size}`);

  // ── Blobs ───────────────────────────────────────────────────────────────────
  let blobCount = 0;
  let blobBytes = 0;
  const missingBlobs: string[] = [];

  if (withBlobs) {
    for (const sid of sessionIds) {
      let gotAny = false;
      for (const name of ["transcript.jsonl", "summary.json"]) {
        const res = await fetch(`${webapiUrl()}/api/s3/sessions/${sid}/${name}`);
        if (!res.ok || !res.body) continue; // absent is normal: summary.json often isn't there
        mkdirSync(paths.blobDir(sid), { recursive: true, mode: 0o700 });
        const target = join(paths.blobDir(sid), name);
        const { bytes, sha256 } = await streamToFile(res.body, target);
        checksums[`blobs/${sid}/${name}`] = sha256;
        blobCount++;
        blobBytes += bytes;
        gotAny = true;
      }
      // A session with metadata and chunks is still worth keeping — record the gap
      // rather than failing the export.
      if (!gotAny) missingBlobs.push(sid);
    }
    console.log(`  blobs   ${blobCount} objects, ${formatBytes(blobBytes)}`);
    if (missingBlobs.length)
      console.log(`  note    ${missingBlobs.length} session(s) had no blobs`);
  } else {
    console.log("  blobs   skipped (--no-blobs)");
  }

  // ── Manifest, last ──────────────────────────────────────────────────────────
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    schemaVersion: await schemaVersion(),
    createdAt: new Date().toISOString(),
    source: { app: await appVersion(), hostname: hostname(), webapi: webapiUrl() },
    counts: { sessions: sessionIds.size, docs: docCount, blobs: blobCount },
    checksums,
    selection: { since, sessions, blobs: withBlobs },
    missingBlobs,
  };
  writeManifest(dir, manifest);

  console.log(`export: done (schema v${manifest.schemaVersion}) → ${dir}`);
  console.log(`  restore with: claude-transcripts import ${dir}`);
  return 0;
}
