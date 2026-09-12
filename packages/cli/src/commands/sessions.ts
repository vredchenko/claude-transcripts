/**
 * `claude-transcripts sessions [id]` — list or inspect sessions through the webapi
 * (the read side of the gateway). No id → a recent-sessions table; with an id →
 * session detail + a transcript preview.
 *
 *   claude-transcripts sessions                 # recent sessions
 *   claude-transcripts sessions --cwd ~/dev/api # only one project
 *   claude-transcripts sessions <id>            # detail + transcript preview
 *   (all accept --limit <n>, --webapi <url> and --json)
 */
import {
  getSession,
  getSessionTranscript,
  listSessions,
  type SessionSummary,
  type TranscriptEntry,
} from "../api/generated";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { type ParsedArgs, parseFlags, strOpt } from "../lib/args";
import { num, pad, padL, project, row, when } from "../lib/format";

/** The sessions table right-aligns from PROMPTS on — the numeric tail. */
const RIGHT_FROM = 4;

/**
 * The list filters, as `GET /api/sessions` names them. `cwd`/`model`/`hostname`/
 * `source` are exact matches (`cwd` ignoring a trailing slash) and are spelled the
 * same as `search`'s, so a filter that narrows one command narrows the other;
 * `from`/`to` are ISO instants and select sessions **overlapping** that window, so
 * asking for a day still returns the session that started the night before.
 *
 * Applied by the gateway, not here: it filters before it pages, so `--limit` counts
 * matching sessions rather than whatever the first page happened to contain.
 */
const FILTERS = ["cwd", "model", "hostname", "source", "from", "to"] as const;

type Filters = Partial<Record<(typeof FILTERS)[number], string>>;

function readFilters(options: ParsedArgs["options"]): Filters {
  const out: Filters = {};
  for (const key of FILTERS) {
    const value = strOpt(options, key);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Is this an ISO 8601 calendar date (with an optional time), and a real one?
 *
 * Both halves matter. `Date.parse` alone accepts `01/08/2026` and reads it as 8
 * January, so a filter written the way most of the world writes dates would quietly
 * select the wrong four months; the shape test rejects it instead. And the shape test
 * alone accepts `2026-13-01`, which `Date.parse` catches.
 */
function isIsoInstant(value: string): boolean {
  return /^\d{4}-\d{2}(-\d{2})?([T ].+)?$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The first `--from`/`--to` the gateway would ignore, as it was typed.
 *
 * `overlapsRange` treats an unparseable bound as **open**, on purpose: a malformed
 * date widens the result set rather than emptying it, so a caller seeing everything
 * can tell something is wrong (see the note on it in the webapi's sessions route).
 * That is the right call for a link someone pasted, and the wrong one the moment this
 * command prints `541 matching (from=yesterday)` above the entire corpus — leniency
 * the caller can't see is indistinguishable from a filter that worked. So the terminal
 * refuses what the URL tolerates.
 */
function unparseableBound(filters: Filters): string | undefined {
  for (const key of ["from", "to"] as const) {
    const value = filters[key];
    if (value !== undefined && !isIsoInstant(value)) return `--${key} ${value}`;
  }
  return undefined;
}

/** " (cwd=/srv/app, source=backfill)", or "" when nothing is filtered. */
function filterNote(filters: Filters): string {
  const parts = Object.entries(filters).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function bytes(n: number | undefined): string {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}

function tools(counts: Record<string, number> | undefined): number {
  return counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
}

export function summaryLine(s: SessionSummary): string {
  return row(
    [
      [s.sessionId.slice(0, 8), 8],
      // `startTimestamp`, not `timestamp`: the latter is the summary's own time — the
      // SessionEnd instant — and only coincides with the start while a session is still
      // running and has no summary yet. Reading it under a "STARTED" heading meant the
      // column silently changed meaning the moment a session ended.
      [when(s.startTimestamp ?? s.timestamp), 16],
      [s.status, 10],
      [project(s.cwd), 18],
      [num(s.promptCount), 7],
      [num(tools(s.toolCounts)), 6],
      [s.tokenUsage ? num(s.tokenUsage.total) : "—", 9],
    ],
    RIGHT_FROM,
  );
}

async function showList(limit: number, json: boolean, filters: Filters): Promise<number> {
  const res = await listSessions({ limit, ...filters });
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  // `totalCount` is of the *filtered* set, so this reads as "matching", not "recorded".
  const matching = Object.keys(filters).length > 0;
  console.log(
    `sessions: ${num(res.totalCount)} ${matching ? "matching" : "total"}${filterNote(filters)} (${webapiUrl()})`,
  );
  if (res.sessions.length === 0) {
    // A filter that matched nothing is a different fact from an empty corpus, and the
    // difference is the whole reason to say anything at all.
    console.log(matching ? "sessions: none match" : "sessions: none recorded yet");
    return 0;
  }
  console.log(
    row(
      [
        ["SESSION", 8],
        ["STARTED", 16],
        ["STATUS", 10],
        ["PROJECT", 18],
        ["PROMPTS", 7],
        ["TOOLS", 6],
        ["TOKENS", 9],
      ],
      RIGHT_FROM,
    ),
  );
  for (const s of res.sessions) console.log(summaryLine(s));
  if (res.sessions.length < res.totalCount) {
    console.log(`… ${num(res.totalCount - res.sessions.length)} more — raise --limit`);
  }
  return 0;
}

/**
 * Compact one-line description of a transcript turn. The webapi normalises both of its
 * sources (CouchDB chunks, S3 blob) to this shape, so there's no raw JSONL to unpick.
 */
// Typed against the *response* contract, not the writer's `ChunkEntry`: what comes back
// is whatever the transcript endpoint sends, and the two differ (the chunks view nulls
// absent fields where `buildChunkEntries` omits them).
function entryLine(entry: TranscriptEntry, i: number): string {
  const tools = (entry.toolUses ?? []).map((t) => `⚙ ${t.name}`).join(" ");
  const text = entry.text ?? "";
  const preview = (text && tools ? `${text} ${tools}` : text || tools)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `  ${padL(`#${i}`, 4)}  ${pad(entry.role, 12)} ${preview}`;
}

async function showDetail(id: string, limit: number, json: boolean): Promise<number> {
  const s = await getSession(id);
  if (json) {
    // Session + transcript preview in one object — what a recall skill needs to cite a
    // session and quote from it, without a second call.
    const transcript = s.hasTranscript ? await getSessionTranscript(id, { limit }) : null;
    console.log(JSON.stringify({ session: s, transcript }, null, 2));
    return 0;
  }
  console.log(`session ${s.sessionId}  [${s.status}]`);
  console.log(`  started    ${s.startTimestamp ?? s.timestamp ?? "—"}`);
  // Now that "started" is the start, the end is worth its own line rather than being
  // the thing "started" was quietly showing.
  if (s.status === "ended") console.log(`  ended      ${s.timestamp ?? "—"}`);
  console.log(`  project    ${s.cwd || "—"}`);
  console.log(`  model      ${s.model ?? "—"}`);
  console.log(`  hostname   ${s.hostname || "—"}`);
  console.log(`  end reason ${s.endReason}`);
  console.log(
    `  counts     ${num(s.promptCount)} prompts · ${num(s.eventCount)} events · ${num(s.errorCount)} errors · ${num(tools(s.toolCounts))} tool calls`,
  );
  if (s.tokenUsage) {
    console.log(
      `  tokens     ${num(s.tokenUsage.total)} total (in ${num(s.tokenUsage.input)} · out ${num(s.tokenUsage.output)} · cache ${num(s.tokenUsage.cacheCreation)}/${num(s.tokenUsage.cacheRead)})`,
    );
  }
  console.log(`  transcript ${s.hasTranscript ? bytes(s.transcriptSize) : "—"}`);

  if (s.hasTranscript) {
    const tr = await getSessionTranscript(id, { limit });
    const from = tr.source === "chunks" ? "live from chunks" : "stored transcript";
    console.log(
      `\ntranscript — first ${num(tr.entries.length)} of ${num(tr.totalCount)} entries (${from}):`,
    );
    for (const [i, e] of tr.entries.entries()) console.log(entryLine(e, i));
    if (tr.hasMore)
      console.log(`  … (${num(tr.totalCount - tr.entries.length)} more — raise --limit)`);
  }
  return 0;
}

export async function runSessions(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const webapiOverride = strOpt(options, "webapi");
  if (webapiOverride) setWebapiUrl(webapiOverride);
  const limitOpt = strOpt(options, "limit");
  const limit = limitOpt ? Number(limitOpt) : positionals[0] ? 30 : 50;
  const id = positionals[0];
  const json = options.json === true;
  const filters = readFilters(options);

  // The filters narrow a list; with an id there is exactly one session and nothing to
  // narrow. Saying so beats silently ignoring half the command line.
  const used = Object.keys(filters).map((f) => `--${f}`);
  if (id && used.length > 0) {
    console.error(
      `sessions: ${used.join(" ")} ${used.length > 1 ? "filter" : "filters"} the list — drop the session id, or drop the ${used.length > 1 ? "filters" : "filter"}`,
    );
    return 2;
  }

  // Checked before the request, so a typo costs a message rather than a page of rows
  // that ignored it.
  const bad = unparseableBound(filters);
  if (bad) {
    console.error(`sessions: ${bad} — not a date the gateway can read, so it would be ignored`);
    console.error(
      "sessions: use an ISO instant, e.g. --from 2026-08-01 or --to 2026-08-31T18:00:00Z",
    );
    return 2;
  }

  try {
    return id ? await showDetail(id, limit, json) : await showList(limit, json, filters);
  } catch (err) {
    console.error(`sessions: failed — ${(err as Error).message}`);
    console.error(
      `sessions: is the webapi reachable at ${webapiUrl()}? (set --webapi or $CT_WEBAPI_URL)`,
    );
    return 1;
  }
}
