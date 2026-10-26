/**
 * `claude-transcripts reconcile` — finalise sessions that never fired `SessionEnd`
 * (the `reconcile-session` action).
 *
 *   claude-transcripts reconcile                  # every session that reads as `incomplete`
 *   claude-transcripts reconcile <id>… [--force]  # these sessions (--force: even if `running`)
 *   claude-transcripts reconcile --dry-run --json
 *
 * A session killed or crashed before `SessionEnd` has event markers and chunks but no
 * `summary:<id>`, so it reads as `incomplete` forever, with no token totals. This
 * writes the summary it never got (`buildReconciledSummary`), and nothing else.
 *
 * Reads and writes go through the webapi, like `backfill` (ADR 0016): the summary is
 * delivered to `/api/ingest/summary`, where it is validated like any other. The
 * webapi's change follower runs this same command on a sweep — the app image ships the
 * CLI — so there is one implementation however the action is started.
 *
 * Safe to repeat: a session that already ended is skipped, and a live `SessionEnd`
 * that turns up later (a resumed session) replaces the reconciled summary.
 */
import { getSession, listSessions, type SessionSummary } from "../api/generated";
import {
  getOrNull,
  getTextOrNull,
  isConnectionError,
  setWebapiUrl,
  unreachableHint,
  webapiReachable,
} from "../api/http";
import { parseFlags, strOpt } from "../lib/args";
import { buildReconciledSummary } from "../lib/session-docs";
import { WebapiSink } from "../lib/sink";

export interface ReconcileOutcome {
  sessionId: string;
  result: "reconciled" | "would-reconcile" | "skipped" | "failed";
  reason?: string;
  /** Whether the S3 transcript was there to count tokens from. */
  tokens?: boolean;
}

const PAGE = 500;

/** Every session the gateway reads as `incomplete`, oldest activity last. */
async function incompleteSessions(): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await listSessions({ status: "incomplete", limit: PAGE, skip });
    out.push(...page.sessions);
    if (out.length >= page.totalCount || page.sessions.length === 0) return out;
  }
}

async function sessionOrNull(id: string): Promise<SessionSummary | null> {
  try {
    return await getSession(id);
  } catch (err) {
    if (isConnectionError(err)) throw err;
    return null;
  }
}

export interface ReconcileOpts {
  dryRun: boolean;
  force: boolean;
  now: string;
  /** Is there an S3 transcript store to look in (`features.s3Blobs`)? */
  blobs: boolean;
  sink: Pick<WebapiSink, "putSummary">;
}

/**
 * Finalise one session, or say why not. Never throws.
 *
 * A transcript that isn't there (404, or no blob store) finalises without token
 * totals. A store that can't answer fails the session instead: the summary is written
 * once, so writing it without tokens because S3 was briefly down would lose them for
 * good — a failed session is simply picked up again next run.
 */
export async function reconcileOne(
  s: SessionSummary,
  opts: ReconcileOpts,
): Promise<ReconcileOutcome> {
  const sessionId = s.sessionId;
  if (s.status === "ended") return { sessionId, result: "skipped", reason: "already ended" };
  if (s.status === "running" && !opts.force) {
    return { sessionId, result: "skipped", reason: "still running (--force to finalise it)" };
  }
  try {
    const transcript = opts.blobs
      ? await getTextOrNull(`/api/s3/sessions/${encodeURIComponent(sessionId)}/transcript.jsonl`)
      : null;
    const doc = buildReconciledSummary(s, transcript, opts.now);
    if (!opts.dryRun) await opts.sink.putSummary(doc);
    return {
      sessionId,
      result: opts.dryRun ? "would-reconcile" : "reconciled",
      tokens: transcript !== null,
    };
  } catch (err) {
    return { sessionId, result: "failed", reason: (err as Error).message };
  }
}

function describe(o: ReconcileOutcome): string {
  const tokens = o.tokens === false ? "  (no S3 transcript — no token totals)" : "";
  switch (o.result) {
    case "reconciled":
      return `  finalised  ${o.sessionId}${tokens}`;
    case "would-reconcile":
      return `  would finalise  ${o.sessionId}${tokens}`;
    case "skipped":
      return `  skipped    ${o.sessionId} — ${o.reason}`;
    case "failed":
      return `  FAILED     ${o.sessionId} — ${o.reason}`;
  }
}

export async function runReconcile(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const webapi = strOpt(options, "webapi");
  if (webapi) setWebapiUrl(webapi);
  const json = options.json === true;
  const dryRun = options["dry-run"] === true;
  const force = options.force === true;

  if (!(await webapiReachable())) {
    console.error(unreachableHint("reconcile"));
    return 1;
  }

  const outcomes: ReconcileOutcome[] = [];
  const now = new Date().toISOString();
  const sink = new WebapiSink();
  try {
    const manifest = await getOrNull<{ features?: Record<string, boolean> }>("/");
    const blobs = manifest?.features?.s3Blobs !== false;
    const sessions: SessionSummary[] = [];
    if (positionals.length) {
      for (const id of positionals) {
        const s = await sessionOrNull(id);
        if (s) sessions.push(s);
        else outcomes.push({ sessionId: id, result: "failed", reason: "no such session" });
      }
    } else {
      sessions.push(...(await incompleteSessions()));
    }
    for (const s of sessions) {
      outcomes.push(await reconcileOne(s, { dryRun, force, now, blobs, sink }));
    }
  } catch (err) {
    console.error(`reconcile: failed — ${(err as Error).message}`);
    console.error(unreachableHint("reconcile"));
    return 1;
  }

  const failed = outcomes.filter((o) => o.result === "failed").length;
  if (json) {
    console.log(JSON.stringify({ dryRun, outcomes }, null, 2));
  } else if (!outcomes.length) {
    console.log("reconcile: nothing to finalise — no session reads as incomplete");
  } else {
    for (const o of outcomes) console.log(describe(o));
    const done = outcomes.filter(
      (o) => o.result === "reconciled" || o.result === "would-reconcile",
    );
    console.log(
      `reconcile: ${dryRun ? "would finalise" : "finalised"} ${done.length}, skipped ${
        outcomes.length - done.length - failed
      }, failed ${failed}`,
    );
  }
  return failed ? 1 : 0;
}
