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
 * The wrapper exists for one reason: **`threshold` does not work.** The option is
 * tested against `Content-Length`, and a `Response` built by a handler has none —
 * per the Fetch standard that header is added by the server when it serialises the
 * response, not by the constructor, so `new Response(body).headers.get()` returns
 * null on Bun *and* on Node. The threshold therefore never fires for anything a
 * route returns, and every response was encoded: a 15-byte JSON body went out as 31
 * bytes of gzip, and all of them became `transfer-encoding: chunked`. So we size the
 * body here — peeking at the stream rather than buffering it, so large responses
 * stay streamed — and hand a small one straight back with a real `Content-Length`.
 *
 * `Vary: Accept-Encoding` used to be missing too, and this wrapper set it. Hono fixed
 * that in **4.13.0** (honojs/hono#5137), which is why the dependency is pinned at or
 * above that: `compress()` now sets `Vary` itself, before it negotiates, so a response
 * left uncompressed because the client asked for no encoding still carries it.
 * Anything this wrapper short-circuits *before* handing off gets no `Vary`, and
 * correctly so — those are the responses that do not vary by encoding at all.
 *
 * Binary responses need no exclusion list: hono's `COMPRESSIBLE_CONTENT_TYPE_REGEX`
 * already declines `application/octet-stream` (the CLI download, proxied blobs) and
 * `text/event-stream`. Change feeds do need one — see {@link isChangeFeed}.
 *
 * **Register this before any route.** A `app.use("*", …)` added *after* the routes
 * it should wrap silently matches nothing, and every response comes back
 * uncompressed with no error to say why.
 */
/**
 * Can this runtime actually compress?
 *
 * hono's `compress()` reaches straight for `CompressionStream`, which Bun did not
 * provide until 1.3.3. Below that it throws *inside* the middleware, so every
 * compressible response became a 500 whose stack named hono rather than the runtime —
 * a broken server pointing at the wrong component.
 *
 * `engines.bun` now declares the floor and CI tests at it, so this should be
 * unreachable in a supported install. It is here because the failure it replaces was
 * so misleading: serving uncompressed is strictly better than serving nothing, and a
 * reader of the log learns the real cause in one line instead of chasing a library
 * that is behaving correctly.
 */
const CAN_COMPRESS = typeof globalThis.CompressionStream === "function";

export function compression(): MiddlewareHandler {
  // Warn once at construction, not per request: a line per response would bury the
  // one fact worth reading, and the answer cannot change while the process lives.
  if (!CAN_COMPRESS) {
    console.warn(
      "[webapi] CompressionStream is unavailable — serving responses uncompressed. " +
        "This runtime is below the supported floor (see `engines.bun`); on Bun, 1.3.3 or newer.",
    );
  }
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

    if (isChangeFeed(c)) return;

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

    // Degrade here rather than at the top: everything above — the sizing, and the
    // `Content-Length` it restores on a body that arrived without one — is worth doing
    // whether or not this runtime can encode, and skipping it would trade a 500 for a
    // subtler wrong answer.
    if (!CAN_COMPRESS) {
      // Advertise the variance anyway. A shared cache populated by this process has to
      // stay correct if the same deployment is later restarted on a runtime that CAN
      // compress; without `Vary` it would hand a stored identity response to a client
      // that asked for gzip and would now get it.
      const vary = c.res.headers.get("Vary");
      if (!vary?.toLowerCase().includes("accept-encoding")) {
        c.res.headers.append("Vary", "Accept-Encoding");
      }
      return;
    }

    // `compress` post-processes whatever `c.res` currently holds, so a no-op `next`
    // runs exactly its encoding half over the body we just sized.
    await encode(c, noop);
  };
}
