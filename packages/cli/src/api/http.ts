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
    throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** GET `path` and report whether it exists (ok). Never throws on 404. */
export async function exists(path: string): Promise<boolean> {
  const res = await fetch(`${BASE}${path}`);
  return res.ok;
}

/** Upload a raw body (the transcript blob — not part of the typed JSON client). */
export async function putRaw(path: string, body: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status} ${res.statusText}`);
}
