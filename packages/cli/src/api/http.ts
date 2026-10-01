/**
 * HTTP transport for the CLI's generated API client.
 *
 * `customFetch` is **orval's mutator** (wired via `output.override.mutator` in
 * orval.config.ts) — the single place the webapi base URL + response unwrapping
 * live, because the CLI is off-origin (unlike the webui). Plus two helpers for the
 * calls that sit outside the typed JSON client: an existence check (404 without
 * throwing) and a raw-body upload (the transcript blob — no JSON schema).
 */

import { readFileSync } from "node:fs";
import { installPaths } from "../lib/paths";

/** The documented default (`.env.template`, docs/start/installation.md). */
const DEFAULT_WEBAPI_PORT = "7650";

/**
 * The base URL, resolved on first use rather than at import.
 *
 * Resolving in a module-level initialiser made importing this file *do* something:
 * read `instance.env`, consult four env vars, and — if any of that threw — take down
 * the import itself. `index.ts` reaches here through its commands, so the blast radius
 * of a mistake in the resolver was every command, at load, before argv was even parsed.
 * A ReferenceError shipped in exactly that shape once (0ef96ca); making it lazy retires
 * the whole class rather than that one instance.
 *
 * Memoised, so a bulk command doing hundreds of requests still reads the instance file
 * once. `setWebapiUrl` fills the same slot, which is what makes `--webapi` skip the
 * lookup entirely instead of racing it.
 */
let resolved: string | null = null;

function base(): string {
  resolved ??= resolveWebapiUrl();
  return resolved;
}

/**
 * Resolve the webapi base URL.
 *
 * In precedence order: `CT_WEBAPI_URL`, then `WEBAPI_PORT` from the environment, then
 * `webapi.url` in the hook runtime config, then **the installed instance's own
 * `instance.env`**, then the default port. (`--webapi` bypasses all of it.)
 *
 * The instance step is the one worth explaining. `install` generates a port per instance,
 * so an install is frequently *not* on 7650 — and without this every command
 * (`sessions`, `doctor`, `reindex`) had to be told `--webapi` or it would report a dead
 * webapi on a port nothing was ever listening on. The instance already writes its port
 * down; reading it is what makes the bare commands work.
 *
 * Which makes it worth being precise about what suppresses that step: the **port** pins
 * the target, and `WEBAPI_HOST` only chooses the host for whichever port is picked.
 * `.env.template` ships a `WEBAPI_HOST` — it is the address a host-run webapi *binds* —
 * and Bun loads that `.env` for anything run out of a checkout. Treating it as "the
 * developer named a target" put every checkout back on 7650 with the install
 * undiscovered, which is the failure the instance lookup exists to prevent. The webui's
 * dev proxy resolves the same way (packages/webui/dev/webapi-target.ts); a checkout's
 * two clients disagreeing about where the webapi lives is its own bug.
 */
export function resolveWebapiUrl(): string {
  if (process.env.CT_WEBAPI_URL) return process.env.CT_WEBAPI_URL.replace(/\/$/, "");
  // `||`, not `??`, for both halves: a blank env var is an unfilled slot, not a choice.
  // `??` keeps `""` and builds `http://:7650` / `http://host:`, URLs that fail at the
  // socket with nothing that points back at the empty line in the .env that caused it.
  const host = process.env.WEBAPI_HOST || "127.0.0.1";
  // An explicit port still wins over the file — that's how a dev checkout points the
  // CLI at a webapi it's running from source.
  if (process.env.WEBAPI_PORT) return `http://${host}:${process.env.WEBAPI_PORT}`;
  return hookConfigWebapiUrl() ?? instanceWebapiUrl() ?? `http://${host}:${DEFAULT_WEBAPI_PORT}`;
}

/**
 * `webapi.url` from the hook runtime config, the one file a machine recording to a
 * *remote* deployment has. Without it every command dialled localhost while the hook
 * wrote elsewhere. Fail-soft like the instance lookup: missing or malformed → null.
 */
function hookConfigWebapiUrl(): string | null {
  try {
    const url = JSON.parse(readFileSync(installPaths().hookConfig, "utf8"))?.webapi?.url;
    return typeof url === "string" && url ? url.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * The webapi URL of the installed instance, read from its generated env file.
 *
 * Best-effort and deliberately quiet: no install, an unreadable file or a missing port
 * all mean "fall through to the default", never an error. This runs before every
 * command, so it must not be able to break one.
 */
function instanceWebapiUrl(): string | null {
  try {
    const raw = readFileSync(installPaths().instanceEnv, "utf8");
    const port = /^WEBAPI_PORT=(\d+)\s*$/m.exec(raw)?.[1];
    if (!port) return null;
    const host = /^WEBAPI_HOST=(\S+)\s*$/m.exec(raw)?.[1] ?? "127.0.0.1";
    // `WEBAPI_HOST` in that file is what the webapi BINDS. `0.0.0.0` means "every
    // interface" to a listener and is not an address to dial: connecting to it happens
    // to work on Linux and does not everywhere. Read it as the loopback it implies.
    // The webui's resolver does the same (packages/webui/dev/webapi-target.ts).
    return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  } catch {
    return null;
  }
}

/** Override the base URL (e.g. from a `--webapi` flag). Call before first request. */
export function setWebapiUrl(url: string): void {
  resolved = url.replace(/\/$/, "");
}

/** The current base URL (for logs/labels). Resolves it if nothing has yet. */
export function webapiUrl(): string {
  return base();
}

/**
 * The line a command prints when it could not get an answer from the webapi: where it
 * looked, and the two ways to point it somewhere else. One wording for every command, so
 * the remedy reads the same whichever one hit it.
 */
export function unreachableHint(command: string): string {
  return `${command}: is the webapi reachable at ${webapiUrl()}? (set --webapi or $CT_WEBAPI_URL)`;
}

/**
 * Socket-level failure codes: Bun's own names, then the Node/undici ones a different
 * runtime or a future Bun might surface instead.
 */
const CONNECTION_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UnableToConnect",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Did this error come from failing to reach the webapi at all, rather than from an
 * answer it gave? The distinction decides whether "is it reachable at <url>?" is the
 * right thing to ask the user — a 500 with a message already says what went wrong.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
  return err.name === "TimeoutError" || err.message.startsWith("Unable to connect");
}

/**
 * One `GET /health`: does anything answer at the webapi URL? Any HTTP response counts
 * — this asks whether there is a webapi to talk to, not whether it is well.
 */
export async function webapiReachable(timeoutMs = 3000): Promise<boolean> {
  try {
    await fetch(`${base()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** orval mutator: perform the request and return the parsed JSON body as `T`. */
export async function customFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${url}`, init);
  if (!res.ok) {
    // Include the server's own explanation — the webapi returns `{error}` on
    // failure, and without it the caller only sees an opaque status code.
    throw new Error(
      `${init?.method ?? "GET"} ${url} → ${res.status} ${res.statusText}${await errorDetail(res)}`,
    );
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Best-effort ": <server message>" for a failed response; "" if there is none. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return "";
    try {
      const body = JSON.parse(text) as { error?: unknown; reason?: unknown };
      const msg = body.error ?? body.reason;
      if (typeof msg === "string" && msg) return `: ${msg}`;
    } catch {
      // not JSON — fall through to the raw text
    }
    return `: ${text.slice(0, 300)}`;
  } catch {
    return "";
  }
}

/** GET `path` and report whether it exists (ok). Never throws on 404. */
export async function exists(path: string): Promise<boolean> {
  const res = await fetch(`${base()}${path}`);
  return res.ok;
}

/**
 * GET a JSON resource, or null when it isn't there.
 *
 * `exists` answers only yes/no, which is enough for idempotency but not for deciding
 * *how* a session may be re-ingested — that turns on what the stored record says about
 * itself. Same 404-tolerant contract, one step further.
 */
export async function getOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${base()}${path}`);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/**
 * Stream a file up as the request body, without reading it into memory.
 *
 * Transcripts dominate a bundle (~100MB across 43 sessions on a real instance), so a
 * restore that buffered each one would scale with the largest session rather than with
 * nothing. `duplex: "half"` is required whenever the body is a stream.
 */
export async function putStream(
  path: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const res = await fetch(`${base()}${path}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: Bun.file(filePath).stream(),
    // Required whenever the body is a stream rather than a buffer.
    duplex: "half",
  });
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status} ${res.statusText}${await errorDetail(res)}`);
  }
}

/** Upload a raw body (the transcript blob — not part of the typed JSON client). */
export async function putRaw(path: string, body: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(`${base()}${path}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status} ${res.statusText}${await errorDetail(res)}`);
  }
}
