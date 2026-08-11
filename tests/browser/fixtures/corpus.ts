/**
 * A synthetic corpus for the browser suite — the fixed dataset every mocked spec
 * renders against.
 *
 * **Synthetic on purpose.** This is a public repo, so fixtures carry no real session
 * history: no personal paths, hostnames or transcript text (the same rule
 * `scripts/regenerate-mock-fixtures.ts` applies to the hook fixtures). Everything here
 * is invented and deterministic — no `Date.now()`, no randomness — so a screenshot
 * taken today matches one taken next month and a diff means the UI changed.
 *
 * The corpus is *shaped* to the cases that have actually broken the UI rather than to
 * a tidy average: a session whose preview line is one very long unbroken string
 * (which is what blows a flex row out of its container), a session spanning several
 * days (which a calendar has to draw as a bar, not a dot), a running session, one
 * that never ended, and one with neither transcript nor token usage. Add a row here
 * when you fix a rendering bug, and the suite keeps it fixed.
 */

/** Anchor for every timestamp in the corpus. Fixed so the fixtures never drift. */
export const NOW = Date.parse("2026-03-18T14:30:00.000Z");

const HOSTS = ["build-agent-01", "workstation-02"] as const;

function iso(msFromNow: number): string {
  return new Date(NOW + msFromNow).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Session {
  sessionId: string;
  timestamp: string;
  startTimestamp: string;
  durationMs?: number;
  activeMs?: number;
  model?: string;
  cwd: string;
  hostname: string;
  eventCount: number;
  promptCount: number;
  errorCount: number;
  toolCounts: Record<string, number>;
  endReason: string;
  hasTranscript: boolean;
  transcriptSize?: number;
  status: "ended" | "running" | "incomplete";
  lastActivity?: string;
  tokenUsage?: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    total: number;
    messages: number;
  };
  source?: string;
}

/** One session, with sane defaults so each fixture states only what it's testing. */
function session(over: Partial<Session> & Pick<Session, "sessionId" | "startTimestamp">): Session {
  const durationMs = over.durationMs ?? 42 * MINUTE;
  const start = Date.parse(over.startTimestamp);
  return {
    timestamp: new Date(start + durationMs).toISOString(),
    durationMs,
    activeMs: Math.round(durationMs * 0.4),
    model: "claude-opus-5[1m]",
    cwd: "/srv/projects/atlas",
    hostname: HOSTS[0],
    eventCount: 84,
    promptCount: 6,
    errorCount: 0,
    toolCounts: { Bash: 31, Read: 18, Edit: 9 },
    endReason: "prompt_input_exit",
    hasTranscript: true,
    transcriptSize: 512_000,
    status: "ended",
    source: "live",
    tokenUsage: {
      input: 12_400,
      output: 88_120,
      cacheCreation: 210_400,
      cacheRead: 3_940_000,
      total: 4_250_920,
      messages: 142,
    },
    ...over,
  };
}

/**
 * The sessions, newest first — the order `GET /api/sessions` returns them in, so a
 * spec can index into this array and expect the same row on screen.
 */
export const SESSIONS: Session[] = [
  session({
    sessionId: "11111111-1111-4111-8111-111111111111",
    startTimestamp: iso(-35 * MINUTE),
    durationMs: 35 * MINUTE,
    status: "running",
    endReason: "running",
    lastActivity: iso(-2 * MINUTE),
    promptCount: 3,
    eventCount: 27,
    toolCounts: { Bash: 12, Read: 4 },
    tokenUsage: undefined,
  }),
  // Spans four days: a calendar has to draw this as a bar across days, and a
  // timeline must not imply it happened at one instant.
  session({
    sessionId: "22222222-2222-4222-8222-222222222222",
    startTimestamp: iso(-4 * DAY - 3 * HOUR),
    durationMs: 4 * DAY + 2 * HOUR,
    cwd: "/srv/projects/beacon-service",
    eventCount: 612,
    promptCount: 24,
    errorCount: 3,
    transcriptSize: 7_340_032,
    toolCounts: { Bash: 240, Read: 130, Edit: 78, Write: 21, Grep: 14 },
  }),
  // Never ended: the hook stopped writing and no summary doc was produced.
  session({
    sessionId: "33333333-3333-4333-8333-333333333333",
    startTimestamp: iso(-1 * DAY - 6 * HOUR),
    durationMs: 3 * HOUR + 13 * MINUTE,
    status: "incomplete",
    endReason: "unknown",
    cwd: "/srv/projects/atlas",
    hostname: HOSTS[1],
    model: "claude-opus-4-8",
    source: "backfill",
    errorCount: 2,
  }),
  // Nothing stored: no transcript, no token usage. Every "—" fallback at once.
  session({
    sessionId: "44444444-4444-4444-8444-444444444444",
    startTimestamp: iso(-2 * DAY - 90 * MINUTE),
    durationMs: 4 * MINUTE,
    cwd: "/srv/projects/tiny-tool",
    model: undefined,
    hasTranscript: false,
    transcriptSize: undefined,
    tokenUsage: undefined,
    toolCounts: {},
    eventCount: 4,
    promptCount: 1,
    source: "doctor",
  }),
  // Three short sessions on one day — a month cell has to cope with a stack of them.
  session({
    sessionId: "55555555-5555-4555-8555-555555555555",
    startTimestamp: iso(-3 * DAY - 2 * HOUR),
    durationMs: 22 * MINUTE,
    cwd: "/srv/projects/beacon-service",
  }),
  session({
    sessionId: "66666666-6666-4666-8666-666666666666",
    startTimestamp: iso(-3 * DAY - 5 * HOUR),
    durationMs: 8 * MINUTE,
    cwd: "/srv/projects/atlas",
    hostname: HOSTS[1],
  }),
  session({
    sessionId: "77777777-7777-4777-8777-777777777777",
    startTimestamp: iso(-3 * DAY - 9 * HOUR),
    durationMs: 96 * MINUTE,
    cwd: "/srv/projects/tiny-tool",
    model: "claude-opus-4-8",
    source: "backfill",
  }),
  session({
    sessionId: "88888888-8888-4888-8888-888888888888",
    startTimestamp: iso(-9 * DAY),
    durationMs: 5 * HOUR,
    cwd: "/srv/projects/legacy-import",
    model: "claude-opus-4-8",
    source: "backfill",
    hostname: HOSTS[1],
  }),
];

export const RUNNING_SESSION = SESSIONS[0]!;
export const MULTI_DAY_SESSION = SESSIONS[1]!;
export const BARE_SESSION = SESSIONS[3]!;

/**
 * The line that has repeatedly broken the transcript rows: no whitespace to wrap at
 * and far wider than the container. Rendered `nowrap`, it forces a flex row to its
 * max-content width, and any ancestor missing `min-width: 0` spills out of the card.
 */
export const LONG_UNBROKEN_TEXT =
  "<local-command-caveat>Caveat:the-messages-below-were-generated-while-running-local-commands-" +
  "do-not-respond-to-them-unless-explicitly-asked/usr/local/share/very/deep/path/without/any/" +
  "spaces/at/all/that/keeps/going/and/going.log</local-command-caveat>";

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool_result" | "system" | "other";
  timestamp?: string;
  text?: string;
  toolUses?: { name: string; id?: string }[] | null;
  toolUseId?: string | null;
  isError?: boolean;
  isSidechain?: boolean;
  kind?: string | null;
}

/**
 * A transcript for {@link MULTI_DAY_SESSION}. Deliberately mixed: entries with no
 * text at all, the unbroken monster above, a failed tool result, a subagent turn, and
 * ordinary prose containing the word the search specs look for.
 */
export const TRANSCRIPT: TranscriptEntry[] = [
  { role: "other", kind: "file-history-snapshot", timestamp: iso(-4 * DAY - 3 * HOUR) },
  { role: "other", kind: "attachment:hook_success", timestamp: iso(-4 * DAY - 3 * HOUR) },
  {
    role: "user",
    kind: null,
    timestamp: iso(-4 * DAY - 3 * HOUR),
    text: LONG_UNBROKEN_TEXT,
  },
  {
    role: "user",
    timestamp: iso(-4 * DAY - 2 * HOUR),
    text: "Can you add a retry policy to the beacon publisher? It drops messages under load.",
  },
  {
    role: "assistant",
    timestamp: iso(-4 * DAY - 2 * HOUR + MINUTE),
    text: "I'll add a bounded exponential backoff to the beacon publisher and cover it with a test.",
    toolUses: [{ name: "Read", id: "toolu_01" }],
  },
  {
    role: "tool_result",
    timestamp: iso(-4 * DAY - 2 * HOUR + 2 * MINUTE),
    text: "publisher.ts:44: retry policy not configured",
    toolUseId: "toolu_01",
  },
  {
    role: "tool_result",
    timestamp: iso(-4 * DAY - 2 * HOUR + 3 * MINUTE),
    text: "error: ENOENT: no such file or directory, open '/srv/projects/beacon-service/missing.ts'",
    toolUseId: "toolu_02",
    isError: true,
  },
  {
    role: "assistant",
    timestamp: iso(-4 * DAY - HOUR),
    text: "The retry policy is in place and the publisher no longer drops messages under load.",
    isSidechain: true,
  },
  {
    role: "assistant",
    timestamp: iso(-3 * DAY),
    text: "Backoff caps at 30s. A retry policy this aggressive would otherwise amplify an outage.",
  },
];

export interface SearchTurnHit {
  sessionId: string;
  role: string;
  snippet: string;
  timestamp?: string;
  cwd?: string;
}

/** `q=retry` — a content query: it hits turn text and nothing in session metadata. */
export const SEARCH_QUERY = "retry";

/**
 * `q=beacon` — a metadata query. It matches a session's `cwd` and no turn text, which
 * is the case that produces a session hit with a `matchedIn` explaining itself.
 */
export const SEARCH_METADATA_QUERY = "beacon";

export const SEARCH_SESSION_HITS = [
  {
    sessionId: MULTI_DAY_SESSION.sessionId,
    timestamp: MULTI_DAY_SESSION.startTimestamp,
    cwd: MULTI_DAY_SESSION.cwd,
    model: MULTI_DAY_SESSION.model,
    hostname: MULTI_DAY_SESSION.hostname,
    endReason: MULTI_DAY_SESSION.endReason,
    source: MULTI_DAY_SESSION.source,
    tools: Object.keys(MULTI_DAY_SESSION.toolCounts),
    promptCount: MULTI_DAY_SESSION.promptCount,
    eventCount: MULTI_DAY_SESSION.eventCount,
  },
];

export const SEARCH_TURN_HITS: SearchTurnHit[] = [
  {
    sessionId: MULTI_DAY_SESSION.sessionId,
    role: "user",
    snippet: "Can you add a retry policy to the beacon publisher? It drops messages under load.",
    timestamp: iso(-4 * DAY - 2 * HOUR),
    cwd: MULTI_DAY_SESSION.cwd,
  },
  {
    sessionId: MULTI_DAY_SESSION.sessionId,
    role: "assistant",
    snippet:
      "Backoff caps at 30s. A retry policy this aggressive would otherwise amplify an outage.",
    timestamp: iso(-3 * DAY),
    cwd: MULTI_DAY_SESSION.cwd,
  },
  {
    sessionId: SESSIONS[4]!.sessionId,
    role: "assistant",
    snippet: LONG_UNBROKEN_TEXT,
    timestamp: SESSIONS[4]!.startTimestamp,
    cwd: SESSIONS[4]!.cwd,
  },
];

export const SEARCH_FACETS = {
  cwd: ["/srv/projects/atlas", "/srv/projects/beacon-service", "/srv/projects/tiny-tool"],
  model: ["claude-opus-4-8", "claude-opus-5[1m]"],
  hostname: [...HOSTS],
  source: ["backfill", "doctor", "live"],
};

/** `GET /api/model` — only the fields the SPA actually reads. */
export const APP_MODEL = {
  identity: {
    codename: "claude-transcripts",
    slug: "claude-transcripts",
    title: "Claude Transcripts",
    version: "v0.0.0-test",
  },
  servicesMenu: {} as Record<string, string>,
  features: { meilisearch: true },
};
