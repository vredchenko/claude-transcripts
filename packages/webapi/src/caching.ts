/**
 * HTTP caching and compression for everything the webapi serves.
 *
 * The webapi hands out a ~670 KB SPA bundle from the same process that answers the
 * API. Until this module existed it did so with no `Content-Encoding`, no
 * `Cache-Control` and no `ETag`, so every visit re-downloaded the whole thing
 * uncompressed. Two pieces fix that: a cache policy for the static trees, and one
 * compression middleware in front of every response.
 *
 * Both live here rather than inline in `server.ts` because the policy is a pure
 * function worth testing on its own, and the middleware is a wrapper whose reasons
 * for existing need explaining.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX, compress } from "hono/compress";

/**
 * Bodies below this are not worth encoding — the gzip framing alone can make a
 * short JSON response *bigger* on the wire. Matches hono's own default.
 */
const THRESHOLD = 1024;

/** A content-hashed artefact: its URL changes whenever its bytes do, so cache it forever. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Everything else: cacheable, but check with us first — the ETag turns that into a 304. */
const REVALIDATE = "no-cache";

/** Which static tree a file was served from. See {@link cacheControlFor}. */
export type StaticKind = "spa" | "docs";

const ASSETS_SEGMENT = /(?:^|\/)assets\//;

/**
 * Is this path inside the SPA's hashed-asset directory?
 *
 * Exported because `server.ts` needs the same answer for a second decision: whether
 * to bother computing an ETag (see the ETag note in {@link cacheControlFor}).
 */
export function isSpaAssetPath(path: string): boolean {
  return ASSETS_SEGMENT.test(path);
}

/**
 * The `Cache-Control` a static file should be served with.
 *
 * Vite writes every content-hashed build artefact into `assets/` under the SPA's
 * output directory, and leaves `index.html` (and anything copied from `public/`)
 * unhashed at the root. That **directory** split is what makes a one-year
 * `immutable` safe — not a guess at the shape of a filename. If the webui ever
 * changes `build.assetsDir` or `assetFileNames`, this is the line to revisit.
 *
 * The docs site is never hashed (`scripts/build-docs.ts` writes `<page>.html` and
 * copies `docs/assets/` verbatim), so it always revalidates — and it has an
 * `assets/` directory of its own, which is exactly why the caller says which tree
 * the path came from instead of this function trying to work it out.
 */
export function cacheControlFor(kind: StaticKind, path: string): string {
  return kind === "spa" && isSpaAssetPath(path) ? IMMUTABLE : REVALIDATE;
}

/** Append a value to `Vary` without duplicating one that is already there. */
function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (existing === null || existing === "") {
    headers.set("Vary", value);
    return;
  }
  // `Vary: *` already means "varies by everything"; narrowing it would be a lie.
  if (existing.trim() === "*") return;
  const listed = existing.split(",").some((v) => v.trim().toLowerCase() === value.toLowerCase());
  if (!listed) headers.set("Vary", `${existing}, ${value}`);
}

/**
 * Would the client take a compressed body at all? Only a cheap pre-check, so we
 * don't buffer a body for nothing — `compress` does the real content negotiation.
 */
function acceptsCompression(c: Context): boolean {
  const accept = c.req.header("Accept-Encoding");
  return accept !== undefined && /\b(?:gzip|deflate|\*)\b/i.test(accept);
}

/**
 * A CouchDB change feed proxied through `/api/couch` streams for as long as the
 * client holds it open. `CompressionStream` waits for enough input to emit a block,
 * so compressing one turns a live feed into a stall. Leave those alone.
 */
function isChangeFeed(c: Context): boolean {
  if (!c.req.path.startsWith("/api/couch")) return false;
  const feed = c.req.query("feed");
  return feed === "continuous" || feed === "longpoll" || feed === "eventsource";
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const first = chunks[0];
  if (chunks.length === 1 && first) return first;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Read just enough of `body` to know whether it is worth compressing.
 *
 * Returns the whole thing as bytes when it ends within `limit`; otherwise returns a
 * stream that replays what was read and then carries on from the original. Reading
 * the entire body instead would defeat streaming for the large responses — proxied
 * blobs, whole transcripts — that are precisely the ones we do want to compress.
 */
async function peekBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= limit) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock();
      return concat(chunks, size);
    }
    if (value) {
      chunks.push(value);
      size += value.byteLength;
    }
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done || !value) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const noop: Next = async () => {};

/**
 * Compress responses — a wrapper around hono's `compress()`, not a replacement.
 *
 * The wrapper earns its place by fixing two things the stock middleware gets wrong
 * here:
 *
 * 1. **It never sets `Vary: Accept-Encoding`.** Without that header a shared cache
 *    is free to store the gzipped body and hand it to the next client, whether or
 *    not that client asked for one. We set it on every compressible response,
 *    compressed or not, which is the form that stays correct either way.
 * 2. **Its `threshold` is inert under Bun.** The option is tested against
 *    `Content-Length`, and a Hono response on Bun carries none — so *every*
 *    response was being encoded, including ones that grew in the process (a 15-byte
 *    JSON body left as 31 bytes of gzip), and all of them became
 *    `transfer-encoding: chunked`. So we size the body ourselves, and hand a small
 *    one straight back with a real `Content-Length` instead.
 *
 * Binary responses need no exclusion list: hono's `COMPRESSIBLE_CONTENT_TYPE_REGEX`
 * already declines `application/octet-stream` (the CLI download, proxied blobs) and
 * `text/event-stream`. Change feeds do need one — see {@link isChangeFeed}.
 *
 * **Register this before any route.** A `app.use("*", …)` added *after* the routes
 * it should wrap silently matches nothing, and every response comes back
 * uncompressed with no error to say why.
 */
export function compression(): MiddlewareHandler {
  const encode = compress({ threshold: THRESHOLD });

  return async function compression(c, next) {
    await next();

    const res = c.res;
    if (
      c.req.method === "HEAD" ||
      !res.body ||
      // 206 refers to a range of the *uncompressed* bytes; 304 has no body to encode.
      res.status === 206 ||
      res.status === 304 ||
      res.headers.has("Content-Encoding")
    ) {
      return;
    }

    const type = res.headers.get("Content-Type");
    if (type === null || !COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)) return;

    appendVary(res.headers, "Accept-Encoding");

    if (isChangeFeed(c) || !acceptsCompression(c)) return;

    const declared = res.headers.get("Content-Length");
    if (declared !== null) {
      if (Number(declared) < THRESHOLD) return;
    } else {
      const peeked = await peekBody(res.body, THRESHOLD);
      if (peeked instanceof Uint8Array) {
        c.res = new Response(peeked, res);
        c.res.headers.set("Content-Length", String(peeked.byteLength));
        return;
      }
      c.res = new Response(peeked, res);
    }

    // `compress` post-processes whatever `c.res` currently holds, so a no-op `next`
    // runs exactly its encoding half over the body we just sized.
    await encode(c, noop);
  };
}
