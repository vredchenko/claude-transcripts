/**
 * `claude-transcripts search <query>` — full-text search across the corpus, through
 * the webapi (the read side of the gateway).
 *
 *   claude-transcripts search "retry policy"
 *   claude-transcripts search retry policy          # bare words are joined
 *   claude-transcripts search auth --cwd ~/dev/api --limit 40
 *
 * Two result sets come back and both are shown, because they answer different
 * questions: `hits` are sessions whose *metadata* matched (project, model, host,
 * tool names), `turns` are places in a conversation where the words were actually
 * said. A query like `Bash` matches the first; `flaky test` matches the second.
 */
import { stripHighlightMarks } from "@claude-transcripts/shared";
import { type SearchHit, search, type TurnHit } from "../api/generated";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";
import { num, project, row, when } from "../lib/format";

/** Widest `ChunkEntryRole` is `tool_result` — narrower and the table lies about it. */
const ROLE_W = 11;

/** Fall back to a sane width when stdout isn't a TTY (a pipe reports nothing). */
function snippetWidth(): number {
  const cols = process.stdout.columns ?? 0;
  // session(8) + when(16) + role + three 2-space gaps of table before the snippet.
  const before = 8 + 2 + 16 + 2 + ROLE_W + 2;
  return Math.max(40, (cols > 0 ? cols : 120) - before);
}

/**
 * One `turns` row. The snippet arrives carrying the private-use highlight
 * delimiters the index put around each match; `stripHighlightMarks` is the
 * documented reader for a plain-text context like this one. Meilisearch has already
 * cropped the snippet around the match, so the match stays visible without them.
 */
export function turnLine(t: TurnHit, width: number = snippetWidth()): string {
  const snippet = stripHighlightMarks(t.snippet ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return row([
    [t.sessionId.slice(0, 8), 8],
    [when(t.timestamp), 16],
    [t.role, ROLE_W],
    [snippet.length > width ? `${snippet.slice(0, width - 1)}…` : snippet, width],
  ]);
}

/**
 * One `hits` row. `matchedIn` is the useful column: a session-metadata match is
 * otherwise unexplained — you see a result and can't tell why it's there.
 */
export function hitLine(h: SearchHit): string {
  return row([
    [h.sessionId.slice(0, 8), 8],
    [when(h.timestamp), 16],
    [project(h.cwd), 20],
    [h.model ?? "—", 22],
    [(h.matchedIn ?? []).join(", ") || "—", 24],
  ]);
}

export async function runSearch(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const webapiOverride = strOpt(options, "webapi");
  if (webapiOverride) setWebapiUrl(webapiOverride);

  // Join bare words so `search retry policy` works without shell quoting.
  const query = positionals.join(" ").trim();
  if (!query) {
    console.error('search: needs something to search for, e.g. `search "retry policy"`');
    return 1;
  }

  const limitOpt = strOpt(options, "limit");
  const offsetOpt = strOpt(options, "offset");

  try {
    const res = await search({
      q: query,
      ...(limitOpt ? { limit: Number(limitOpt) } : {}),
      ...(offsetOpt ? { offset: Number(offsetOpt) } : {}),
      ...(strOpt(options, "cwd") ? { cwd: strOpt(options, "cwd") } : {}),
      ...(strOpt(options, "model") ? { model: strOpt(options, "model") } : {}),
      ...(strOpt(options, "hostname") ? { hostname: strOpt(options, "hostname") } : {}),
      ...(strOpt(options, "source") ? { source: strOpt(options, "source") } : {}),
    });

    // Machine-readable: the webapi response as-is (the contract the skills read).
    if (options.json === true) {
      console.log(JSON.stringify(res, null, 2));
      return res.enabled ? 0 : 1;
    }

    // A disabled index isn't an error the user made, but it does mean the question
    // went unanswered — so say how to fix it and exit non-zero rather than printing
    // an empty result that reads like "nothing matched".
    if (!res.enabled) {
      console.error("search: search is not enabled on this instance.");
      console.error(
        "search: turn on `features.meilisearch` in config/config.json, bring up the stack,",
      );
      console.error("search: then run `claude-transcripts reindex` to populate the indexes.");
      return 1;
    }

    console.log(
      `search: "${res.query}" — ${num(res.totals.sessions)} sessions, ${num(res.totals.turns)} turns (${webapiUrl()})`,
    );

    if (res.hits.length === 0 && res.turns.length === 0) {
      console.log("search: no matches");
      return 0;
    }

    if (res.hits.length > 0) {
      console.log(
        `\nsessions — ${num(res.hits.length)} of ${num(res.totals.sessions)} (metadata match)`,
      );
      console.log(
        row([
          ["SESSION", 8],
          ["STARTED", 16],
          ["PROJECT", 20],
          ["MODEL", 22],
          ["MATCHED IN", 24],
        ]),
      );
      for (const h of res.hits) console.log(hitLine(h));
    }

    if (res.turns.length > 0) {
      const width = snippetWidth();
      console.log(
        `\nturns — ${num(res.turns.length)} of ${num(res.totals.turns)} (conversation match)`,
      );
      console.log(
        row([
          ["SESSION", 8],
          ["WHEN", 16],
          ["WHO", ROLE_W],
          ["SNIPPET", width],
        ]),
      );
      for (const t of res.turns) console.log(turnLine(t, width));
    }

    const shown = res.hits.length + res.turns.length;
    const total = res.totals.sessions + res.totals.turns;
    if (shown < total) {
      console.log(`\n… ${num(total - shown)} more — raise --limit, or page with --offset`);
    }
    console.log("\nOpen one with: claude-transcripts sessions <session>");
    return 0;
  } catch (err) {
    console.error(`search: failed — ${(err as Error).message}`);
    console.error(
      `search: is the webapi reachable at ${webapiUrl()}? (set --webapi or $CT_WEBAPI_URL)`,
    );
    return 1;
  }
}
