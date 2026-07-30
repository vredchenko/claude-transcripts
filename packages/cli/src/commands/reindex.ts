/**
 * `claude-transcripts reindex` — rebuild the Meilisearch indexes from CouchDB.
 *
 *   claude-transcripts reindex [--webapi <url>]
 *
 * The indexes are **derived** state: they're populated as a side effect of writes
 * through `/api/ingest/*`. So anything already in CouchDB that never went through that
 * path — history adopted before search existed, or written by the hook straight to
 * CouchDB — is invisible to search until it's rebuilt, and a doc deleted from CouchDB
 * lingers in the index. This is the operation that makes search match the store.
 *
 * It clears each index first, so it drops stale entries too, and it waits for
 * Meilisearch's asynchronous validation — a rejected batch is reported, not silently
 * swallowed the way the ingest hot path has to swallow it.
 */
import { searchReindex } from "../api/generated";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";

function num(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export async function runReindex(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const url = strOpt(options, "webapi");
  if (url) setWebapiUrl(url);

  console.log(`reindex: rebuilding search indexes via ${webapiUrl()}`);
  const res = await searchReindex();

  if (!res.enabled) {
    console.log("reindex: search is disabled (features.meilisearch off, or MEILI_HOST unset)");
    return 0;
  }

  console.log(`  sessions  ${num(res.sessions.indexed)} / ${num(res.sessions.scanned)} indexed`);
  console.log(`  turns     ${num(res.turns.indexed)} / ${num(res.turns.scanned)} indexed`);

  if (res.failures.length) {
    console.error("\nreindex: Meilisearch rejected part of the rebuild:");
    for (const f of res.failures) console.error(`  ! ${f}`);
    return 1;
  }
  if (res.turns.scanned === 0) {
    console.log(
      "\nreindex: no turns to index — content search needs full-content chunks " +
        "(`features.couchFullContentChunks`); byte-range-only chunks carry no text.",
    );
  }
  return 0;
}
