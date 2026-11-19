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
 * The target is named as the statusline names it (the webapi's `host:port`), so the
 * two agree at a glance; mirrors follow in brackets.
 */
export function recordingBanner(targets: Targets, sessionId: string): string {
  // Name the mirrors rather than counting them: the reader should be able to tell
  // where their history is going without opening the config.
  const also = targets.mirrors.length
    ? ` (+ mirrors: ${targets.mirrors.map(hostOf).join(", ")})`
    : "";
  const head = `● Claude Transcripts recording → ${whereLabel(targets)}${also}`;
  const link = sessionLink(targets.webapiUrl, sessionId);
  return link ? `${head}\n  ${link}` : head;
}

/**
 * The webapi didn't answer the session-start probe. Said before the first write is
 * lost, with what recovers it — nothing is buffered (#288). The hook still tries every
 * write, so if the webapi comes back mid-session the statusline turns green.
 */
export function unreachableBanner(targets: Targets, reason: string): string {
  return (
    `○ Claude Transcripts NOT recording — ${whereLabel(targets)}: ${reason}.\n` +
    "  Writes are retried per event; recover any gap later with `claude-transcripts backfill`."
  );
}

/**
 * The negative case, which is the important one: a silent hook and a broken hook look
 * identical from inside Claude Code, so "not recording" has to be said out loud — and
 * why, when the config can say ({@link hookConfigProblem}).
 */
export function notRecordingBanner(problem?: string | null): string {
  return `○ Claude Transcripts not recording — ${problem ?? NOT_CONFIGURED}.`;
}

const NOT_CONFIGURED = "no instance configured. Run `claude-transcripts install`";

/** The no-config banner, kept for callers that have no config path to ask about. */
export const NOT_RECORDING_BANNER = notRecordingBanner();

/** The Claude Code hook-output envelope for SessionStart, or null if there is nothing to say. */
export function sessionStartEnvelope(out: SessionStartOutput): object | null {
  // One banner: the recording line first, then any notices under it.
  const systemMessage = [out.systemMessage, ...(out.notices ?? [])].filter(Boolean).join("\n");
  if (!systemMessage && !out.additionalContext) return null;
  return {
    ...(systemMessage ? { systemMessage } : {}),
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
