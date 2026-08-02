/**
 * HTTP transport for the CLI's generated API client.
 *
 * `customFetch` is **orval's mutator** (wired via `output.override.mutator` in
 * orval.config.ts) — the single place the webapi base URL + response unwrapping
 * live, because the CLI is off-origin (unlike the webui). Plus two helpers for the
 * calls that sit outside the typed JSON client: an existence check (404 without
 * throwing) and a raw-body upload (the transcript blob — no JSON schema).
 */

let BASE = resolveWebapiUrl();

/** Resolve the webapi base URL from env (CT_WEBAPI_URL, else WEBAPI_HOST/PORT). */
export function resolveWebapiUrl(): string {
  if (process.env.CT_WEBAPI_URL) return process.env.CT_WEBAPI_URL.replace(/\/$/, "");
  const host = process.env.WEBAPI_HOST ?? "127.0.0.1";
  const port = process.env.WEBAPI_PORT ?? "7650";
  return `http://${host}:${port}`;
}

/** Override the base URL (e.g. from a `--webapi` flag). Call before first request. */
export function setWebapiUrl(url: string): void {
  BASE = url.replace(/\/$/, "");
}

/** The current base URL (for logs/labels). */
export function webapiUrl(): string {
  return BASE;
}

/** orval mutator: perform the request and return the parsed JSON body as `T`. */
export async function customFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, init);
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
  const res = await fetch(`${BASE}${path}`);
  return res.ok;
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
  const res = await fetch(`${BASE}${path}`, {
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
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status} ${res.statusText}${await errorDetail(res)}`);
  }
}
