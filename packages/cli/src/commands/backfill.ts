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
 *
 * Provenance: real per-entry timestamps from the transcript are preserved (so
 * history reads at true system time, never at backfill time); `source: "backfill"` +
 * `backfilled_at` tag how/when the record was adopted. Idempotent + `--dry-run`.
 *
 * Chunk-doc reconstruction and subagent sub-transcripts are still TODO (see the
 * NOTE at the end + docs/tools.md).
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
  const sink = makeSink({ dryRun, webapiUrl: strOpt(options, "webapi") });

  const who = `host=${host}${actor ? `, actor=${actor}` : ""}`;
  console.log(`backfill: scanning ${root} → ${sink.label}${dryRun ? " (dry-run)" : ""}  [${who}]`);
  const found = await discoverTranscripts(root);
  console.log(`backfill: ${found.length} transcript(s) found`);

  let written = 0;
  let skipped = 0;
  let failed = 0;
  let sidechains = 0;
  for (const t of found) {
    try {
      if (!dryRun && (await sink.hasSummary(t.sessionId))) {
        skipped++;
        continue;
      }
      const jsonl = await readTranscript(t.path);
      const facts = deriveSessionFacts(jsonl, { hostname: host, sessionIdHint: t.sessionId });
      if (facts.hasSidechains) sidechains++;

      await sink.putSummary(buildSummaryDoc(facts, "backfill", { actor, backfilledAt }));
      await sink.putEvents(buildEventDocs(jsonl, facts, "backfill"));
      await sink.putChunks(buildChunkDocs(jsonl, facts, "backfill", maxEntriesPerChunk));
      await sink.putTranscript(t.sessionId, new TextEncoder().encode(jsonl));
      written++;
    } catch (err) {
      failed++;
      console.error(`  ! ${t.sessionId}: ${(err as Error).message}`);
    }
  }

  console.log(`backfill: ${written} backfilled, ${skipped} skipped, ${failed} failed`);
  console.log(
    "backfill: NOTE — summary + per-event markers + chunk docs reconstructed" +
      `${sidechains ? `; subagent sub-transcripts (${sidechains} session(s) have them) still TODO` : ""}` +
      " (see docs/tools.md).",
  );
  return failed > 0 ? 1 : 0;
}
