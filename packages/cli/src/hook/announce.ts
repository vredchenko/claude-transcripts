/**
 * The session-start banner: one line, in the transcript, saying whether this session
 * is being recorded and where (docs/design/plugin.md, Part 1a).
 *
 * This is the hook's only use of stdout. `SessionStart` is one of the few events whose
 * hook stdout Claude Code reads (as JSON: `systemMessage` shows to the user), and it
 * is the only event this is bound to. Nothing else in the hook may print to stdout —
 * on every other event it would be dropped into a debug log at best.
 *
 * Pure: takes the resolved targets, returns the text. The handler decides what to do
 * with it, and the tests don't need a session to check the wording.
 */
import type { Targets } from "./runtime";

/** The Claude Code hook-output envelope for a SessionStart banner. */
export interface SessionStartOutput {
  systemMessage: string;
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

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

export function sessionStartOutput(message: string): SessionStartOutput {
  return { systemMessage: message };
}

/** Print the hook-output JSON. Never throws — a failed banner must not fail the hook. */
export function emitSessionStart(message: string): void {
  try {
    process.stdout.write(`${JSON.stringify(sessionStartOutput(message))}\n`);
  } catch {
    // non-fatal
  }
}
