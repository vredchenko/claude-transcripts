/**
 * The session-start banner: one line, in the transcript, saying whether this session
 * is being recorded and where (docs/design/plugin.md, Part 1a).
 *
 * SessionStart is the hook's only use of stdout. It is one of the few events whose
 * hook stdout Claude Code reads — as a single JSON object: `systemMessage` shows to the
 * user, `hookSpecificOutput.additionalContext` goes to Claude. Nothing else in the
 * hook may print to stdout — on every other event it would be dropped into a debug
 * log at best.
 *
 * Pure: takes the resolved targets, returns the text. The handler decides what to do
 * with it, and the tests don't need a session to check the wording.
 */
import { sessionLink, whereLabel } from "../lib/statusline";
import { hostOf, type SessionStartOutput, type Targets } from "./runtime";

/**
 * Two lines: what is recording where, then the link on a line of its own. A banner is
 * plain text (Claude Code draws no colour or OSC 8 in it), so the link only becomes
 * clickable where the terminal spots URLs itself — and it spots one far more reliably
 * when nothing is glued to either end of it.
 *
 * The store is named as the statusline names it (`db@host`), so the two agree at a
 * glance; the S3 bucket and the mirrors follow in brackets.
 */
export function recordingBanner(targets: Targets, sessionId: string): string {
  const also: string[] = [];
  if (targets.bucket) also.push(`s3://${targets.bucket}`);
  // Name the mirrors rather than counting them. A bare "+ 1 mirror(s)" let a banner
  // headline a store that was dead while the mirror held everything — the reader could
  // not tell where their history was actually going without opening the config.
  if (targets.mirrors.length) {
    also.push(`mirrors: ${targets.mirrors.map(hostOf).join(", ")}`);
  }
  const head = `● Claude Transcripts recording → ${whereLabel(targets)}${also.length ? ` (+ ${also.join(", ")})` : ""}`;
  const link = sessionLink(targets.webapiUrl, sessionId);
  return link ? `${head}\n  ${link}` : head;
}

/**
 * The negative case, which is the important one: a silent hook and a broken hook look
 * identical from inside Claude Code, so "not recording" has to be said out loud.
 */
export const NOT_RECORDING_BANNER =
  "○ Claude Transcripts not recording — no instance configured. Run `claude-transcripts install`.";

/** The Claude Code hook-output envelope for SessionStart, or null if there is nothing to say. */
export function sessionStartEnvelope(out: SessionStartOutput): object | null {
  if (!out.systemMessage && !out.additionalContext) return null;
  return {
    ...(out.systemMessage ? { systemMessage: out.systemMessage } : {}),
    ...(out.additionalContext
      ? {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: out.additionalContext,
          },
        }
      : {}),
  };
}

/** Print the hook-output JSON, once. Never throws — a failed banner must not fail the hook. */
export function emitSessionStart(out: SessionStartOutput): void {
  try {
    const envelope = sessionStartEnvelope(out);
    if (envelope) process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } catch {
    // non-fatal
  }
}
