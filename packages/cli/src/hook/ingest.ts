/**
 * The hook's one write path: a webapi's `/api/ingest/*` surface (#288).
 *
 * The webapi is the single write interface (ADR 0016). The hook used to be the
 * exception — it wrote CouchDB and S3 directly so that recording never depended on a
 * webapi being up — but that bought nothing in the omnibus (stores and webapi share one
 * container), cost a store credential on every client, and never delivered the
 * "lossless" it promised: a stale store target lost events just as silently. Now every
 * write goes to the instance's webapi, plus any mirrors, which are simply more webapis.
 *
 * It is the same surface `import` and `backfill` use, so the doc shapes are known to
 * travel: `summary` upserts on its stable id, `chunk` ids are deterministic so a
 * re-flush conflicts benignly instead of duplicating, and events are append-only.
 *
 * Two rules, neither negotiable:
 *
 * - **Never block a session.** Every request has its own timeout, and a failure is
 *   reported, not thrown. An unreachable webapi costs one timeout per event.
 * - **Fail loudly.** Every outcome — with *why* it failed — reaches `onWrite`, which
 *   the statusline renders. Nothing is buffered: a session recorded while the webapi
 *   was down is recovered with `backfill`, and the statusline says so.
 */
import { stripTrailingSlashes } from "@claude-transcripts/shared";

/** A webapi this machine writes into: its own instance, or a mirror. */
export interface WebapiTarget {
  /** Base URL of the instance, e.g. `https://logs.example.com`. */
  url: string;
  /**
   * Cap for ordinary per-event writes. Deliberately short: `PostToolUse` fires on
   * every tool call and Claude Code gives that hook 5s in total, so a webapi that has
   * gone away must give up well inside that budget.
   */
  timeoutMs?: number;
  /**
   * Cap for the end-of-session transcript upload. Generous, because a long session's
   * transcript is megabytes and the upload runs in a detached process that nothing
   * waits on, outside Claude Code's SessionEnd budget (#217).
   */
  blobTimeoutMs?: number;
  /** `user:password` for an instance that sits behind basic auth. Omit for none. */
  auth?: string;
}

/** Kept for configs and docs that say "mirror": a mirror is just another webapi. */
export type MirrorTarget = WebapiTarget;

/**
 * A webapi URL reduced to what identifies the instance: scheme, host and port
 * lowercased (by `URL`), default ports dropped, credentials ignored, trailing slashes
 * stripped. A string that does not parse is compared trimmed and lowercased.
 */
export function webapiKey(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}${stripTrailingSlashes(u.pathname)}`;
  } catch {
    return stripTrailingSlashes(url.trim()).toLowerCase();
  }
}

/**
 * The mirrors that are really the instance itself: same URL as `webapi`, once
 * normalised. Such an entry was harmless before #288, when the hook wrote the stores
 * and the mirror was its only webapi write; now the webapi is the write target, so it
 * doubles every write into the same instance (#306).
 */
export function redundantMirrors(
  webapi: { url?: unknown } | undefined,
  mirrors: readonly { url?: unknown }[] | undefined,
): string[] {
  if (typeof webapi?.url !== "string" || !Array.isArray(mirrors)) return [];
  const own = webapiKey(webapi.url);
  return mirrors
    .map((m) => m?.url)
    .filter((u): u is string => typeof u === "string" && webapiKey(u) === own);
}

/** One write's outcome. `reason` is short enough for a statusline. */
export type WriteOutcome = { ok: true } | { ok: false; reason: string };

/** Everything the hook writes, by kind. Ids live in the docs, as ingest expects. */
export interface IngestClient {
  event(doc: Record<string, unknown>): Promise<void>;
  /** A chunk with a deterministic `_id`; a re-flush of the same span is a no-op. */
  chunk(doc: Record<string, unknown>, timeoutMs?: number): Promise<void>;
  /** The session rollup; replaces any earlier one (a resumed session ends twice). */
  summary(doc: Record<string, unknown>, timeoutMs?: number): Promise<void>;
  /** The byte-faithful transcript, stored by the webapi in S3 (ADR 0014). */
  transcript(sessionId: string, data: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_BLOB_TIMEOUT_MS = 60_000;

export function baseUrl(target: WebapiTarget): string {
  return stripTrailingSlashes(target.url);
}

export function authHeaders(target: WebapiTarget): Record<string, string> {
  return target.auth ? { Authorization: `Basic ${btoa(target.auth)}` } : {};
}

/** Why a request failed, in a word or two: `HTTP 503`, `timeout`, `unreachable`. */
export function failureReason(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "unreachable";
}

/** An {@link IngestClient} for one webapi. */
export function makeIngestClient(
  target: WebapiTarget,
  onWrite?: (outcome: WriteOutcome) => void,
): IngestClient {
  const base = baseUrl(target);
  const json = { "Content-Type": "application/json", ...authHeaders(target) };
  const fallback = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = async (
    method: string,
    path: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<void> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      onWrite?.(res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` });
    } catch (err) {
      onWrite?.({ ok: false, reason: failureReason(err) });
    }
  };

  return {
    event: (doc) =>
      send("POST", "/api/ingest/events", JSON.stringify({ docs: [doc] }), json, fallback),
    chunk: (doc, timeoutMs) =>
      send(
        "POST",
        "/api/ingest/chunks",
        JSON.stringify({ docs: [doc] }),
        json,
        timeoutMs ?? fallback,
      ),
    summary: (doc, timeoutMs) =>
      send("POST", "/api/ingest/summary", JSON.stringify(doc), json, timeoutMs ?? fallback),
    transcript: (sessionId, data) =>
      send(
        "PUT",
        `/api/ingest/${encodeURIComponent(sessionId)}/transcript`,
        data,
        { "Content-Type": "application/x-ndjson", ...authHeaders(target) },
        target.blobTimeoutMs ?? DEFAULT_BLOB_TIMEOUT_MS,
      ),
  };
}

/**
 * Write to every client at once.
 *
 * `allSettled` over a started array, not a sequential loop: the instance must not wait
 * behind a mirror, and one target's failure must not skip the rest. Awaiting at all is
 * still necessary — the hook process is short-lived, and an un-awaited fetch dies with
 * it.
 */
export function fanOut(clients: IngestClient[]): IngestClient {
  const only = clients.length === 1 ? clients[0] : undefined;
  if (only) return only;
  const all = async (f: (c: IngestClient) => Promise<void>) => {
    await Promise.allSettled(clients.map(f));
  };
  return {
    event: (doc) => all((c) => c.event(doc)),
    chunk: (doc, t) => all((c) => c.chunk(doc, t)),
    summary: (doc, t) => all((c) => c.summary(doc, t)),
    transcript: (id, data) => all((c) => c.transcript(id, data)),
  };
}

/** How long the session-start reachability probe waits. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Is the instance's webapi there, with its stores behind it? Asked once at session
 * start so the banner can say "not recording" before the first write is lost, rather
 * than after. `/health` answers `ok: false` when CouchDB is unreachable, which would
 * make every ingest write fail too.
 */
export async function probeWebapi(
  target: WebapiTarget,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<WriteOutcome> {
  try {
    const res = await fetch(`${baseUrl(target)}/health`, {
      headers: authHeaders(target),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return body.ok === false ? { ok: false, reason: "stores unavailable" } : { ok: true };
  } catch (err) {
    return { ok: false, reason: failureReason(err) };
  }
}

/** How long a resume waits on the webapi for the chunk high-water mark. */
const HIGH_WATER_TIMEOUT_MS = 2_000;

/**
 * The furthest `byte_end` of a session's chunks, from the instance's webapi, or null
 * when there are none or it can't say in time. Mirrors aren't asked — they may lag.
 */
export async function fetchChunkHighWater(
  target: WebapiTarget,
  sessionId: string,
  timeoutMs = HIGH_WATER_TIMEOUT_MS,
): Promise<number | null> {
  try {
    const res = await fetch(
      `${baseUrl(target)}/api/ingest/${encodeURIComponent(sessionId)}/high-water`,
      { headers: authHeaders(target), signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return null;
    const { bytes } = (await res.json()) as { bytes?: unknown };
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}
