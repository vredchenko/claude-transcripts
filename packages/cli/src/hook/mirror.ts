/**
 * Mirror targets — the same session history written to more than one instance.
 *
 * The hook writes straight to CouchDB and S3 so that recording a session never
 * depends on a webapi being up
 * ([ADR 0016](../../../../docs/design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).
 * That works because those stores are *this machine's* — bound to localhost, no
 * round-trip worth worrying about.
 *
 * A second instance somewhere else is the case that breaks the assumption. Its
 * CouchDB and S3 are bound to *its* localhost and are not reachable at all; the only
 * thing exposed is the webapi, whose `/api/couch` and `/api/s3` proxies are
 * deliberately read-only. So a mirror cannot be "another `couch.url`" — it has to go
 * through the one write surface a remote instance actually offers: `/api/ingest`.
 *
 * Which is the same surface `import` uses to restore a bundle, so the doc shapes are
 * already known to travel: `summary` upserts on its stable id, `chunk` ids are
 * deterministic so a re-flush conflicts benignly instead of duplicating, and events are
 * append-only. A mirror is therefore just a live, incremental `import`.
 *
 * Two rules inherited from the hook, and neither is negotiable:
 *
 * - **A mirror must never block a session.** Every request is bounded by its own
 *   timeout and every failure is swallowed. An unreachable mirror costs one timeout,
 *   not a session.
 * - **A mirror must never degrade the primary.** Fan-out writes start together rather
 *   than in sequence, so the local store is never waiting behind a remote one.
 */
import type { BlobClient, CouchClient } from "./runtime";

/** One additional instance that receives the same writes, reached through its webapi. */
export interface MirrorTarget {
  /** Base URL of the instance, e.g. `https://logs.example.com`. */
  url: string;
  /**
   * Cap for ordinary per-event writes. Deliberately short: `PostToolUse` fires on
   * every tool call and Claude Code gives that hook 5s in total, so a mirror that has
   * gone away must give up well inside that budget.
   */
  timeoutMs?: number;
  /**
   * Cap for the end-of-session transcript upload. Generous, because it runs only at
   * `SessionEnd` (a 180s hook) and a long session's transcript is megabytes.
   */
  blobTimeoutMs?: number;
  /** `user:password` for an instance that sits behind basic auth. Omit for none. */
  auth?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_BLOB_TIMEOUT_MS = 60_000;
const TRANSCRIPT_SUFFIX = "/transcript.jsonl";

function baseUrl(target: MirrorTarget): string {
  return target.url.replace(/\/+$/, "");
}

function authHeaders(target: MirrorTarget): Record<string, string> {
  return target.auth ? { Authorization: `Basic ${btoa(target.auth)}` } : {};
}

/**
 * Route a doc to the ingest endpoint that accepts it.
 *
 * `null` for anything else — a doc kind the remote has no curated endpoint for is
 * skipped rather than guessed at, which is the same call `import` makes.
 */
function ingestRoute(doc: Record<string, unknown>): { path: string; body: unknown } | null {
  switch (doc.type) {
    case "event":
      return { path: "/api/ingest/events", body: { docs: [doc] } };
    case "chunk":
      return { path: "/api/ingest/chunks", body: { docs: [doc] } };
    case "summary":
      return { path: "/api/ingest/summary", body: doc };
    default:
      return null;
  }
}

/** A {@link CouchClient} that writes through a remote instance's ingest surface. */
export function makeMirrorCouch(target: MirrorTarget): CouchClient {
  const base = baseUrl(target);
  const headers = { "Content-Type": "application/json", ...authHeaders(target) };
  const fallback = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = async (doc: Record<string, unknown>, timeoutMs: number): Promise<void> => {
    const route = ingestRoute(doc);
    if (!route) return;
    try {
      await fetch(`${base}${route.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(route.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // non-fatal
    }
  };

  return {
    async postDoc(_db, doc) {
      await send(doc as Record<string, unknown>, fallback);
    },
    // The id lives in the URL for a direct PUT; ingest reads it from the body, so it
    // moves into the doc. It overrides rather than merges: the caller's id is the one
    // that makes a chunk re-flush replace instead of duplicate.
    async putDoc(_db, id, doc, timeoutMs) {
      await send({ ...(doc as Record<string, unknown>), _id: id }, timeoutMs ?? fallback);
    },
  };
}

/** A {@link BlobClient} that ships transcripts to a remote instance's ingest surface. */
export function makeMirrorBlob(target: MirrorTarget): BlobClient {
  const base = baseUrl(target);
  const timeout = target.blobTimeoutMs ?? DEFAULT_BLOB_TIMEOUT_MS;

  return {
    enabled: true,
    async put(_bucket, key, data, contentType) {
      // Only the transcript has an ingest endpoint. `summary.json` is a convenience
      // copy of a doc that is itself mirrored, so dropping it loses nothing — the same
      // reason `import` skips it.
      if (!key.endsWith(TRANSCRIPT_SUFFIX)) return;
      const sessionId = key.slice(0, -TRANSCRIPT_SUFFIX.length);
      if (!sessionId) return;
      try {
        await fetch(`${base}/api/ingest/${encodeURIComponent(sessionId)}/transcript`, {
          method: "PUT",
          headers: { "Content-Type": contentType, ...authHeaders(target) },
          body: data,
          signal: AbortSignal.timeout(timeout),
        });
      } catch {
        // non-fatal
      }
    },
  };
}

/**
 * Write to every client at once.
 *
 * `allSettled` over a started array, not a sequential loop: the primary must not wait
 * behind a mirror, and one target's failure must not skip the rest. Awaiting at all is
 * still necessary — the hook process is short-lived, and an un-awaited fetch dies with
 * it.
 */
export function fanOutCouch(clients: CouchClient[]): CouchClient {
  const only = clients.length === 1 ? clients[0] : undefined;
  if (only) return only;
  return {
    async postDoc(db, doc) {
      await Promise.allSettled(clients.map((c) => c.postDoc(db, doc)));
    },
    async putDoc(db, id, doc, timeoutMs) {
      await Promise.allSettled(clients.map((c) => c.putDoc(db, id, doc, timeoutMs)));
    },
  };
}

/**
 * As {@link fanOutCouch}, for blobs.
 *
 * `enabled` is true when *any* target can take a blob, so a machine with no local S3
 * key still mirrors its transcripts — the handlers gate on this flag, and gating on the
 * primary alone would silently drop the one copy that exists.
 */
export function fanOutBlob(clients: BlobClient[]): BlobClient {
  const active = clients.filter((c) => c.enabled);
  const only = active.length === 1 ? active[0] : undefined;
  if (only) return only;
  return {
    enabled: active.length > 0,
    async put(bucket, key, data, contentType) {
      await Promise.allSettled(active.map((c) => c.put(bucket, key, data, contentType)));
    },
  };
}
