/**
 * HTTP transport for the webui's generated API client.
 *
 * `customFetch` is **orval's mutator** (wired via `output.override.mutator` in
 * orval.config.ts), the same arrangement the CLI uses — one place for transport
 * concerns so the generated file stays purely about the contract
 * ([ADR 0019](../../../../docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)).
 *
 * Two jobs, and both are the reason a mutator exists rather than orval's stock fetch
 * client:
 *
 * - **Unwrap.** Orval's fetch client resolves `{ data, status, headers }` even for a
 *   500, so every component would have to unpack the envelope *and* check the status by
 *   hand — react-query would never see a failure, and `isError` would be dead code.
 *   Throwing on a non-2xx puts errors back where react-query can handle them.
 * - **Base URL.** The webui is served under `/app` with `/api` proxied to the webapi, so
 *   requests are same-origin and the spec's paths (`/api/...`) are already correct.
 *   Nothing is prepended — orval's `baseUrl` would produce `/api/api/...`.
 */

/** The webapi's error body shape; any route may return it. */
interface ApiErrorBody {
  error?: unknown;
  reason?: unknown;
}

/** A failed request, carrying the status so a component can distinguish 404 from 500. */
export class ApiRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/** Best-effort ": <server message>" for a failed response; "" if there is none. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return "";
    try {
      const body = JSON.parse(text) as ApiErrorBody;
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

/**
 * The type of a rejected request, as orval should describe it.
 *
 * Orval otherwise infers the error type from each route's *error response schema* —
 * `ApiError`, the `{ error }` body. That is what the server sends, but not what the
 * caller catches: `customFetch` throws, so react-query's `error` is an
 * {@link ApiRequestError}. Without this, `error.message` doesn't typecheck and
 * components can't hand the value to anything expecting an `Error`. Orval picks this
 * export up from the mutator module by name.
 */
export type ErrorType<_ResponseBody> = ApiRequestError;

/** orval mutator: perform the request and resolve the parsed JSON body as `T`. */
export async function customFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ApiRequestError(
      `${init?.method ?? "GET"} ${url} → ${res.status} ${res.statusText}${await errorDetail(res)}`,
      res.status,
    );
  }
  // 204/205/304 carry no body; everything else the webapi returns is JSON.
  if ([204, 205, 304].includes(res.status)) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
