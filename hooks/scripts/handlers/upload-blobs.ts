import { readFileSync } from "node:fs";
import type { HookContext } from "../lib/context";

/** Action `upload-blobs`: at SessionEnd, upload the byte-faithful transcript to S3
 *  (`<sessionId>/transcript.jsonl`) — S3 is the transcript's sole durable home
 *  (ADR 0014). The summary.json blob is written by write-summary. */
export async function handle(ctx: HookContext): Promise<void> {
  if (!ctx.blob.enabled || !ctx.sessionsBucket || !ctx.transcriptPath) return;

  let data: string;
  try {
    data = readFileSync(ctx.transcriptPath, "utf8");
  } catch {
    return; // nothing to upload
  }

  await ctx.blob.put(
    ctx.sessionsBucket,
    `${ctx.sessionId}/transcript.jsonl`,
    data,
    "application/x-ndjson",
  );
}
