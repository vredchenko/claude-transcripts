import { readFileSync } from "node:fs";
import { commonFields, type HookContext } from "../lib/context";
import { sumTranscriptTokens } from "../transcript-tokens";

/** Action `write-summary`: at SessionEnd, compute the rollup + token usage and
 *  write `summary:<sessionId>` to CouchDB (a session is `ended` once it exists).
 *  Also stashes summary.json in S3; the transcript blob is handled by upload-blobs.
 *  Handlers run in parallel, so this is self-contained. */
export async function handle(ctx: HookContext): Promise<void> {
  const counts = ctx.counts.read();

  let jsonl = "";
  let transcriptBytes = 0;
  if (ctx.transcriptPath) {
    try {
      jsonl = readFileSync(ctx.transcriptPath, "utf8");
      transcriptBytes = Buffer.byteLength(jsonl);
    } catch {
      // transcript unreadable — record what we can
    }
  }

  const doc = {
    type: "summary",
    ...commonFields(ctx),
    end_reason: ctx.payload?.reason ?? "unknown",
    event_count: counts.events,
    prompt_count: counts.prompts,
    error_count: counts.errors,
    tool_counts: counts.tools,
    transcript_bytes: transcriptBytes,
    token_usage: sumTranscriptTokens(jsonl),
    system_checks: {},
    source: "live", // live-recorded (vs "import" from the CLI) — see docs/couchdb-documents.md
  };

  await ctx.couch.putDoc(ctx.sessionsDb, `summary:${ctx.sessionId}`, doc, 30000);

  if (ctx.blob.enabled && ctx.sessionsBucket) {
    await ctx.blob.put(
      ctx.sessionsBucket,
      `${ctx.sessionId}/summary.json`,
      JSON.stringify(doc),
      "application/json",
    );
  }

  ctx.counts.clear();
}
