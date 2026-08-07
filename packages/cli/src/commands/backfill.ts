/**
 * `claude-transcripts backfill` — adopt on-disk `~/.claude` transcripts as first-class session
 * history. For each session it reconstructs the same shape a live-recorded session
 * has — the `summary:<id>` doc + per-event marker docs (and, planned, `chunk` docs)
 * — then delivers them to the webapi. The full transcript goes to S3.
 *
 * (Not to be confused with `import`/`export`, which move portable *bundles* of app
 * data; `backfill` ingests raw Claude Code transcripts off the filesystem.)
 *
 *   claude-transcripts backfill [--dir <path>] [--host <name>] [--actor <who>] [--webapi <url>] [--dry-run]
 *                              [--force [--session <id>]] [--chunk-size <n>] [--no-content]
 *
 * Provenance: real per-entry timestamps from the transcript are preserved (so
 * history reads at true system time, never at backfill time); `source: "backfill"` +
 * `backfilled_at` tag how/when the record was adopted. Idempotent + `--dry-run`.
 *
 * By default a session that already has a summary doc is skipped, which makes repeat
 * runs cheap but also means a session adopted with `--no-content`, or by an older CLI
 * that wrote byte-range-only chunks, could never be redone — the only way out was
 * deleting docs by hand. `--force` re-processes: it deletes the session's derived docs
 * first, because re-ingesting over the top doesn't replace them (events would
 * duplicate, and chunks are keyed by byte offset, so re-chunking would leave the old
 * ones alongside the new). The S3 transcript is never deleted, only overwritten.
 *
 * Chunk-doc reconstruction and subagent sub-transcripts are still TODO (see the
 * NOTE at the end + docs/operate/tools.md).
 */
import { hostname } from "node:os";
import { parseFlags, strOpt } from "../lib/args";
import { defaultProjectsDir, discoverTranscripts, readTranscript } from "../lib/claude-fs";
import { buildChunkDocs, buildEventDocs, buildSummaryDoc } from "../lib/session-docs";
import { makeSink } from "../lib/sink";
import { deriveSessionFacts } from "../lib/transcript";

export async function runBackfill(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const dryRun = options["dry-run"] === true;
  const root = strOpt(options, "dir") ?? defaultProjectsDir();
  const host = strOpt(options, "host") ?? hostname();
  const actor = strOpt(options, "actor");
  const backfilledAt = new Date().toISOString();
  const chunkSizeOpt = strOpt(options, "chunk-size");
  const maxEntriesPerChunk = chunkSizeOpt ? Number(chunkSizeOpt) : undefined;
  // Full-content chunks (ADR 0027) are embedded by default; `--no-content` opts out
  // (byte-range-only chunks — content then lives in the S3 transcript alone).
  const withContent = options["no-content"] !== true;
  const force = options.force === true;
  // `--session <id>` narrows a forced run to one session, so redoing a single session
  // doesn't mean re-processing an entire machine's history. (Single-valued, matching
  // `export --session`; the flag parser doesn't do repeats.)
  const onlySession = strOpt(options, "session");
  const only = new Set(onlySession ? [onlySession] : []);
  const sink = makeSink({ dryRun, webapiUrl: strOpt(options, "webapi") });

  if (only.size && !force) {
    console.error("backfill: --session only applies with --force (without it, new sessions are");
    console.error("backfill: adopted anyway and existing ones are skipped).");
    return 2;
  }

  const who = `host=${host}${actor ? `, actor=${actor}` : ""}`;
  console.log(`backfill: scanning ${root} → ${sink.label}${dryRun ? " (dry-run)" : ""}  [${who}]`);
  const found = await discoverTranscripts(root);
  console.log(`backfill: ${found.length} transcript(s) found`);
  if (force) {
    const scope = only.size ? `${only.size} named session(s)` : "every already-adopted session";
    console.log(`backfill: --force — re-processing ${scope} (derived docs are replaced)`);
  }

  let written = 0;
  let skipped = 0;
  let failed = 0;
  let sidechains = 0;
  let reprocessed = 0;
  for (const t of found) {
    try {
      if (only.size && !only.has(t.sessionId)) {
        skipped++;
        continue;
      }
      if (!dryRun && (await sink.hasSummary(t.sessionId))) {
        if (!force) {
          skipped++;
          continue;
        }
        // Clear first: an upsert only covers the summary, so without this the old
        // events and chunks would survive the rewrite and be read back alongside.
        const gone = await sink.resetSession(t.sessionId);
        console.log(
          `  ~ ${t.sessionId}: cleared ${gone.summary} summary, ${gone.events} event(s), ` +
            `${gone.chunks} chunk(s)`,
        );
        reprocessed++;
      }
      const jsonl = await readTranscript(t.path);
      const facts = deriveSessionFacts(jsonl, { hostname: host, sessionIdHint: t.sessionId });
      if (facts.hasSidechains) sidechains++;

      await sink.putSummary(buildSummaryDoc(facts, "backfill", { actor, backfilledAt }));
      await sink.putEvents(buildEventDocs(jsonl, facts, "backfill"));
      await sink.putChunks(
        buildChunkDocs(jsonl, facts, "backfill", maxEntriesPerChunk, withContent),
      );
      await sink.putTranscript(t.sessionId, new TextEncoder().encode(jsonl));
      written++;
    } catch (err) {
      failed++;
      console.error(`  ! ${t.sessionId}: ${(err as Error).message}`);
    }
  }

  console.log(
    `backfill: ${written} backfilled${reprocessed ? ` (${reprocessed} re-processed)` : ""}, ` +
      `${skipped} skipped, ${failed} failed`,
  );
  console.log(
    "backfill: NOTE — summary + per-event markers + chunk docs reconstructed" +
      `${sidechains ? `; subagent sub-transcripts (${sidechains} session(s) have them) still TODO` : ""}` +
      " (see docs/operate/tools.md).",
  );
  if (reprocessed && !dryRun) {
    // Re-ingest overwrites the search entries it regenerates, but turns belonging to
    // chunks that no longer exist stay indexed until a rebuild — `reindex` is the
    // documented reconciliation step for deletes (ADR 0009).
    console.log("backfill: run `claude-transcripts reindex` — search still holds the old turns.");
  }
  return failed > 0 ? 1 : 0;
}
