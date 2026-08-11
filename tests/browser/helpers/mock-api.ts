/**
 * A fake webapi, served straight into the browser by Playwright's request
 * interception.
 *
 * Why not point the specs at a real stack? Because a browser suite should fail only
 * when the *UI* is wrong. Running against CouchDB + Garage + Meilisearch makes every
 * spec depend on ingest, indexing latency and whatever history happens to be on the
 * machine — so it can't run in CI, and a red result rarely means what it says. Here
 * the data is fixed ({@link ../fixtures/corpus}), so a failure is a front-end change
 * and a screenshot diff is a rendering diff.
 *
 * The handlers do the paging, filtering and 404s for real rather than returning one
 * canned blob: paging bugs are exactly the kind this suite should catch, and a mock
 * that ignores `skip` would hide them.
 *
 * Specs that want the real thing skip all of this — see `LIVE` in `./app.ts`.
 */
import type { Page, Route } from "@playwright/test";
import {
  APP_MODEL,
  SEARCH_FACETS,
  SEARCH_SESSION_HITS,
  SEARCH_TURN_HITS,
  SESSIONS,
  type Session,
  TRANSCRIPT,
} from "../fixtures/corpus";

/** Total bytes the fake transcript "covers" — only its presence matters to the UI. */
const BYTE_COVERAGE = 128_000;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** A query param as a non-negative integer, or `fallback` when absent/garbage. */
function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function findSession(id: string): Session | undefined {
  return SESSIONS.find((s) => s.sessionId === id);
}

/**
 * Options for {@link mockApi}, so a spec can bend the corpus to the state it is about
 * without inventing a second fixture set.
 */
export interface MockApiOptions {
  /** Serve `enabled: false` from `/api/search`, as an unconfigured Meilisearch does. */
  searchDisabled?: boolean;
  /** Serve no sessions at all, for the empty state. */
  empty?: boolean;
  /** Fail every `/api/sessions*` read with a 500, for the error state. */
  failSessions?: boolean;
}

/**
 * Install the fake webapi on `page`. Call before the first navigation.
 *
 * Unmatched `/api/**` paths get a 404 rather than falling through to the network: a
 * spec that quietly hit a real backend would be the worst of both worlds.
 */
export async function mockApi(page: Page, options: MockApiOptions = {}): Promise<void> {
  const sessions = options.empty ? [] : SESSIONS;

  // Matched by pathname prefix, not by a `**/api/**` glob: the app's own source
  // includes `src/api/generated.ts`, which such a glob happily swallows — the dev
  // server's module then 404s and the SPA renders a blank page, with nothing in the
  // failure to say why. Only a top-level `/api/` path is the webapi.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;

      if (path === "/api/model") return json(route, APP_MODEL);

      if (options.failSessions && path.startsWith("/api/sessions")) {
        return json(route, { error: "CouchDB unreachable" }, 500);
      }

      if (path === "/api/sessions") {
        const limit = intParam(url, "limit", 50);
        const skip = intParam(url, "skip", 0);
        // `from`/`to` narrow the window to a date range (the calendar and timeline
        // projections ask for one). Unknown to older builds, which simply omit them.
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const inRange = sessions.filter((s) => {
          if (from && s.timestamp < from) return false;
          if (to && s.startTimestamp > to) return false;
          return true;
        });
        return json(route, {
          sessions: inRange.slice(skip, skip + limit),
          totalCount: inRange.length,
        });
      }

      const detail = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (detail) {
        const found = findSession(decodeURIComponent(detail[1]!));
        return found ? json(route, found) : json(route, { error: "Session not found" }, 404);
      }

      const transcript = /^\/api\/sessions\/([^/]+)\/transcript$/.exec(path);
      if (transcript) {
        const found = findSession(decodeURIComponent(transcript[1]!));
        if (!found) return json(route, { error: "Session not found" }, 404);
        if (!found.hasTranscript) {
          return json(route, {
            entries: [],
            totalCount: 0,
            hasMore: false,
            source: "chunks",
            byteCoverage: 0,
          });
        }
        const limit = intParam(url, "limit", 100);
        const offset = intParam(url, "offset", 0);
        const page_ = TRANSCRIPT.slice(offset, offset + limit);
        return json(route, {
          entries: page_,
          totalCount: TRANSCRIPT.length,
          hasMore: offset + page_.length < TRANSCRIPT.length,
          source: found.status === "running" ? "chunks" : "s3",
          byteCoverage: BYTE_COVERAGE,
        });
      }

      const turns = /^\/api\/sessions\/([^/]+)\/turns$/.exec(path);
      if (turns) {
        const found = findSession(decodeURIComponent(turns[1]!));
        if (!found) return json(route, { error: "Session not found" }, 404);
        const role = url.searchParams.get("role");
        const matching = TRANSCRIPT.filter((e) => e.text && (!role || e.role === role));
        return json(route, {
          turns: matching.map((e) => ({
            role: e.role,
            timestamp: e.timestamp ?? "",
            text: e.text ?? "",
            toolUses: e.toolUses ?? null,
            toolUseId: e.toolUseId ?? null,
            isError: e.isError ?? false,
          })),
          totalCount: matching.length,
          hasMore: false,
          role: role ?? null,
        });
      }

      if (path === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (options.searchDisabled) {
          return json(route, {
            hits: [],
            turns: [],
            query: q,
            enabled: false,
            totals: { sessions: 0, turns: 0 },
            facets: { cwd: [], model: [], hostname: [], source: [] },
          });
        }
        if (!q) {
          return json(route, {
            hits: [],
            turns: [],
            query: "",
            enabled: true,
            totals: { sessions: 0, turns: 0 },
            facets: SEARCH_FACETS,
          });
        }
        // Substring matching stands in for Meilisearch's ranking. It is not the same
        // engine, but it is honest about which fixture rows a query should reach.
        const needle = q.toLowerCase();
        const cwd = url.searchParams.get("cwd");
        const hits = SEARCH_SESSION_HITS.filter(
          (h) =>
            (!cwd || h.cwd === cwd) &&
            [h.cwd, h.model, h.hostname, ...(h.tools ?? [])]
              .join(" ")
              .toLowerCase()
              .includes(needle),
        );
        const turnHits = SEARCH_TURN_HITS.filter(
          (t) => (!cwd || t.cwd === cwd) && t.snippet.toLowerCase().includes(needle),
        );
        const limit = intParam(url, "limit", 20);
        const offset = intParam(url, "offset", 0);
        return json(route, {
          hits: hits.slice(offset, offset + limit),
          turns: turnHits.slice(offset, offset + limit),
          query: q,
          enabled: true,
          totals: { sessions: hits.length, turns: turnHits.length },
          facets: SEARCH_FACETS,
        });
      }

      return json(route, { error: `no fixture for ${path}` }, 404);
    },
  );
}
