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
 * `--dry-run` writes nothing and reads everything: which of adopt / skip / repair a
 * session gets turns entirely on what is already stored, so a preview that answered
 * that from nothing could only ever print `adopt`.
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
 * `--repair` also re-uploads a transcript that never reached S3 while the chunks are
 * intact — what a cancelled SessionEnd leaves behind. That is blob-only and touches no
 * document, so it is safe on a session whose chunks are exactly the part that is fine.
 *
 * `--repair` is the additive path: for a session that is already adopted but has no
 * readable turn content — the shape a host leaves behind when its hook was never
 * configured to write `chunk` docs — it writes the missing chunks and re-uploads the
 * transcript, and touches neither the summary nor the event markers. It refuses a session
 * that is still running (its transcript is a moving target) and one that already has
 * turns (chunk ids are keyed by byte offset, so the hook's offsets will not line up with
 * a whole-file partition and both sets would survive); that case wants `--replace-live`.
 *
 * `--force` refuses **live-recorded** sessions unless `--replace-live` is also given.
 * `--force` exists to redo a reconstruction; a `source: "live"` record was written by
 * the hook as the session happened and carries provenance the transcript cannot yield
 * again — `end_reason`, the model, token usage, real per-event markers. Rebuilding it
 * is a downgrade rather than a redo, and the destructive half runs before anything is
 * written, so a mistake is not recoverable from here.
 *
 * Chunk-doc reconstruction and subagent sub-transcripts are still TODO (see the
 * NOTE at the end + docs/operate/tools.md).
 */
import { hostname } from "node:os";
import { webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";
import { defaultProjectsDir, discoverTranscripts, readTranscript } from "../lib/claude-fs";
import { buildChunkDocs, buildEventDocs, buildSummaryDoc } from "../lib/session-docs";
import { DryRunSink, type ExistingSession, makeSink } from "../lib/sink";
import { deriveSessionFacts } from "../lib/transcript";

/**
 * What re-ingesting this session may do, given what is already stored.
 *
 * Pure and exported so the refusal can be tested without a sink: the destructive step
 * runs before anything is written, so the decision is the part that has to be right.
 */
export type ReingestPlan =
  | { action: "adopt" }
  | { action: "repair" }
  /** Blob only: the chunks are fine, the S3 transcript is missing. */
  | { action: "repair-blob" }
  | { action: "skip"; reason: "already-adopted" | "live-record" | "running" | "has-turns" };

export function planReingest(
  existing: ExistingSession | null,
  opts: {
    force: boolean;
    replaceLive: boolean;
    repair?: boolean;
    hasTurns?: boolean;
    hasBlob?: boolean;
  },
): ReingestPlan {
  if (!existing) return { action: "adopt" };

  // `--repair` adds what is missing instead of replacing what is there: a session whose
  // hook wrote no chunk docs has a perfectly good summary and event markers and no
  // readable content. Rebuilding the whole record to get the content back would throw
  // away the half that survived.
  if (opts.repair) {
    // A live session is still being written; its transcript is a moving target and the
    // hook will chunk the rest itself once it is configured to.
    if (existing.status === "running") return { action: "skip", reason: "running" };
    // Chunks are out of scope once a session has turns: their ids are byte offsets, so
    // the hook's will not line up with a whole-file partition and writing over a
    // partially-chunked session leaves both sets behind. That case wants --replace-live.
    //
    // The blob is a different object with a fixed key, and re-uploading it touches no
    // Couch document at all — so "readable, but the verbatim copy never landed" is
    // repairable even though re-chunking is not. That state is what a cancelled
    // SessionEnd leaves: the Couch writes finish and the upload is killed, and nothing
    // reports it because the session still reads fine from chunks.
    if (opts.hasTurns) {
      return opts.hasBlob === false
        ? { action: "repair-blob" }
        : { action: "skip", reason: "has-turns" };
    }
    return { action: "repair" };
  }

  if (!opts.force) return { action: "skip", reason: "already-adopted" };
  // `--force` exists to redo a reconstruction. A live record was written by the hook as
  // the session happened and carries provenance the transcript cannot yield again, so
  // rebuilding it is a downgrade rather than a redo and takes its own opt-in.
  if (existing.source === "live" && !opts.replaceLive) {
    return { action: "skip", reason: "live-record" };
  }
  return { action: "adopt" };
}

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
  // Opt-in to the one case `--force` refuses on its own: replacing a live-recorded
  // session with a reconstruction. Deliberately a separate word rather than a second
  // `--force`, so it cannot be reached by escalating a habit.
  const replaceLive = options["replace-live"] === true;
  // Add missing chunk docs to an already-adopted session, leaving its summary and event
  // markers alone. The recovery path for a host whose hook never wrote chunks.
  const repair = options.repair === true;
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
  if (repair && (force || replaceLive)) {
    console.error("backfill: --repair cannot be combined with --force or --replace-live —");
    console.error("backfill: repair adds what is missing, those replace what is there.");
    return 2;
  }
  if (replaceLive && !force) {
    console.error("backfill: --replace-live only applies with --force (it widens what --force");
    console.error("backfill: may overwrite; on its own it would widen nothing).");
    return 2;
  }

  const who = `host=${host}${actor ? `, actor=${actor}` : ""}`;
  console.log(`backfill: scanning ${root} → ${sink.label}${dryRun ? " (dry-run)" : ""}  [${who}]`);
  const found = await discoverTranscripts(root);
  console.log(`backfill: ${found.length} transcript(s) found`);
  if (repair) {
    console.log(
      "backfill: --repair — adding missing chunk docs only; summaries and event markers " +
        "are left untouched",
    );
  }
  if (force) {
    const scope = only.size ? `${only.size} named session(s)` : "every already-adopted session";
    console.log(
      `backfill: --force — re-processing ${scope} (derived docs are deleted, then rebuilt)`,
    );
    console.log(
      replaceLive
        ? "backfill: --replace-live — live-recorded sessions WILL be replaced by reconstructions"
        : "backfill: live-recorded sessions are left alone (--replace-live overrides)",
    );
  }

  let written = 0;
  let skipped = 0;
  let failed = 0;
  let sidechains = 0;
  let reprocessed = 0;
  let refusedLive = 0;
  let repaired = 0;
  for (const t of found) {
    try {
      if (only.size && !only.has(t.sessionId)) {
        skipped++;
        continue;
      }
      // Asked on a dry run too. Short-circuiting it here was half of why a preview
      // could only ever say "adopt" — see DryRunSink for the other half.
      const existing = await sink.existingSession(t.sessionId);
      // Only asked in repair mode, and only when there is a record to repair — an extra
      // round trip per session is not worth paying on an ordinary run.
      const hasTurns = repair && existing ? await sink.hasTurns(t.sessionId) : false;
      // Only when the chunks would otherwise end it: one extra HEAD, on the sessions a
      // plain --repair used to walk away from.
      const hasBlob = hasTurns ? await sink.hasTranscriptBlob(t.sessionId) : undefined;
      const plan = planReingest(existing, { force, replaceLive, repair, hasTurns, hasBlob });
      if (plan.action === "skip") {
        if (plan.reason === "live-record") {
          console.warn(
            `  ! ${t.sessionId}: skipped — recorded live. --force would delete that record and ` +
              "rebuild it from the transcript, losing provenance only the hook had. Pass " +
              "--replace-live to do that deliberately.",
          );
          refusedLive++;
        }
        // Repair's two refusals are ordinary and expected on a whole-machine run, so they
        // are reported quietly — but reported, because "nothing happened" and "everything
        // was already fine" look identical otherwise.
        if (plan.reason === "running") {
          console.log(`  · ${t.sessionId}: skipped — still running`);
        }
        if (plan.reason === "has-turns") {
          console.log(`  · ${t.sessionId}: skipped — already has turn content and a transcript`);
        }
        skipped++;
        continue;
      }
      if (plan.action === "repair-blob") {
        const jsonl = await readTranscript(t.path);
        await sink.putTranscript(t.sessionId, new TextEncoder().encode(jsonl));
        console.log(`  + ${t.sessionId}: re-uploaded the transcript (chunks left alone)`);
        repaired++;
        continue;
      }
      if (plan.action === "repair") {
        const jsonl = await readTranscript(t.path);
        const facts = deriveSessionFacts(jsonl, { hostname: host, sessionIdHint: t.sessionId });
        const chunks = buildChunkDocs(jsonl, facts, "backfill", maxEntriesPerChunk, withContent);
        await sink.putChunks(chunks);
        await sink.putTranscript(t.sessionId, new TextEncoder().encode(jsonl));
        console.log(`  + ${t.sessionId}: added ${chunks.length} chunk doc(s)`);
        repaired++;
        continue;
      }
      if (existing) {
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

  // A preview that could not read the store guessed, and has to say so — reporting
  // every session as new is exactly the bug this replaced.
  if (sink instanceof DryRunSink && sink.blind) {
    console.warn(
      `backfill: WARNING — could not read ${webapiUrl()}, so this preview assumed nothing ` +
        "is stored yet. A real run will skip whatever is already there; re-run the " +
        "preview once the webapi is reachable to see the true plan.",
    );
  }
  console.log(
    `backfill: ${written} backfilled${repaired ? `, ${repaired} repaired` : ""}` +
      `${reprocessed ? ` (${reprocessed} re-processed)` : ""}, ` +
      `${skipped} skipped${refusedLive ? ` (${refusedLive} live, not replaced)` : ""}, ` +
      `${failed} failed`,
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
