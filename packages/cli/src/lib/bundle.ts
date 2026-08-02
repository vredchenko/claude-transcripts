/**
 * The portable bundle format (bundles.md).
 *
 * A bundle is a **directory**, not an archive: it streams, a failed import resumes,
 * ordinary tools can inspect it, and nothing here needs a tar implementation. It
 * carries only what cannot be recomputed — design docs, the schema marker, the search
 * checkpoint and the search indexes are all deliberately left out, because each is
 * either owned by migrations, instance-specific, or derived.
 *
 *   <bundle>/manifest.json
 *   <bundle>/docs.ndjson                        one CouchDB doc per line, _rev stripped
 *   <bundle>/blobs/<sessionId>/transcript.jsonl
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bundle format version — deliberately independent of the app version, because a
 *  bundle outlives the release that wrote it. Bump only on a breaking layout change. */
export const BUNDLE_FORMAT = 1;

export const MANIFEST_FILE = "manifest.json";
export const DOCS_FILE = "docs.ndjson";
export const BLOBS_DIR = "blobs";

export interface BundleManifest {
  format: number;
  /** The source's migration version — what drives migrate-forward on import. */
  schemaVersion: number;
  createdAt: string;
  source: { app: string; hostname: string; webapi: string };
  counts: { sessions: number; docs: number; blobs: number };
  /** sha256 of each written file, keyed by bundle-relative path. */
  checksums: Record<string, string>;
  /** What was asked for, kept for provenance when reading a bundle back later. */
  selection: { since: string | null; sessions: string[] | null; blobs: boolean };
  /** Sessions whose blobs were expected but absent (adopted --no-content, S3 down). */
  missingBlobs: string[];
}

/**
 * Doc ids a bundle never carries.
 *
 * `_design/*` belongs to migrations — importing a stale copy could overwrite the
 * target's views. `schema_version` describes the *target's* position, and the manifest
 * already records the source's. `search_checkpoint` names an offset in one particular
 * CouchDB's change feed and means nothing anywhere else.
 */
export function isExportableDoc(id: string, type?: string): boolean {
  if (id.startsWith("_design/")) return false;
  if (id === "schema_version" || type === "schema_version") return false;
  if (id === "search_checkpoint" || type === "search_checkpoint") return false;
  return true;
}

export function bundlePaths(dir: string) {
  return {
    dir,
    manifest: join(dir, MANIFEST_FILE),
    docs: join(dir, DOCS_FILE),
    blobs: join(dir, BLOBS_DIR),
    blobDir: (sessionId: string) => join(dir, BLOBS_DIR, sessionId),
  };
}

/** Create the bundle directory tree. 0700 — see the privacy note in bundles.md. */
export function prepareBundleDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, BLOBS_DIR), { recursive: true, mode: 0o700 });
}

export function writeManifest(dir: string, manifest: BundleManifest): void {
  writeFileSync(bundlePaths(dir).manifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readManifest(dir: string): BundleManifest {
  const p = bundlePaths(dir).manifest;
  if (!existsSync(p)) {
    // The manifest is written last, so its absence means the export never finished —
    // better to say that than to half-restore a truncated dump.
    throw new Error(`no ${MANIFEST_FILE} in ${dir} — not a bundle, or the export was interrupted`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as BundleManifest;
}

/** A doc as it appears in a bundle: source `_id` preserved, `_rev` stripped. */
export function toBundleDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const { _rev, ...rest } = doc as Record<string, unknown> & { _rev?: string };
  return rest;
}

/**
 * Stream a response body to a file, hashing as it goes.
 *
 * Blobs are ~11x the size of everything else in a bundle, so they're never held in
 * memory, and the checksum is computed on the way past rather than by re-reading.
 */
export async function streamToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher("sha256");
  const sink = Bun.file(path).writer();
  let bytes = 0;
  try {
    for await (const chunk of body) {
      hasher.update(chunk);
      sink.write(chunk);
      bytes += chunk.byteLength;
    }
  } finally {
    await sink.end();
  }
  restrictMode(path);
  return { bytes, sha256: `sha256:${hasher.digest("hex")}` };
}

/**
 * Tighten a bundle file to 0600.
 *
 * `Bun.file().writer()` honours the umask, which on most systems leaves a
 * world-readable file — not acceptable for something that is, in full, everything
 * ever typed into Claude Code on this machine. The directory is already 0700; this is
 * the second lock on the same door.
 */
export function restrictMode(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort: a bundle on a filesystem without POSIX modes is still usable
  }
}

/** sha256 of a file already on disk (used by import to verify a bundle). */
export async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return `sha256:${hasher.digest("hex")}`;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}
