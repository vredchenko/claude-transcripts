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
import type { SessionStartOutput, Targets } from "./runtime";

/** Where a recorded session can be opened, if the instance has a webapi URL. */
export function sessionLink(webapiUrl: string | undefined, sessionId: string): string | null {
  return webapiUrl ? `${webapiUrl.replace(/\/$/, "")}/app/sessions/${sessionId}` : null;
}

export function recordingBanner(targets: Targets, sessionId: string): string {
  const where = [`couchdb://${targets.couchUrl.replace(/^https?:\/\//, "")}/${targets.sessionsDb}`];
  if (targets.bucket) where.push(`s3://${targets.bucket}`);
  if (targets.mirrors.length) where.push(`${targets.mirrors.length} mirror(s)`);
  const link = sessionLink(targets.webapiUrl, sessionId);
  return `Claude Transcripts — recording to ${where.join(" + ")}${link ? ` · ${link}` : ""}`;
}

/**
 * The negative case, which is the important one: a silent hook and a broken hook look
 * identical from inside Claude Code, so "not recording" has to be said out loud.
 */
export const NOT_RECORDING_BANNER =
  "Claude Transcripts — not recording (no instance configured). Run `claude-transcripts install`.";

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
