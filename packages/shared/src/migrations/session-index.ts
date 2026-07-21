/**
 * `_design/session_index` — a per-session aggregate view (added by migration v2).
 *
 * A session is written as many append-only docs: `event` markers throughout, and a
 * single `summary` doc at SessionEnd. The list/detail reader needs **one row per
 * session** so it can surface sessions that have started but not yet ended
 * (`running`) or crashed before their summary landed (`incomplete`) — not just the
 * ended ones the `summary`-keyed views cover.
 *
 * The `aggregate` view maps every `event`/`summary` doc to a common-shaped value and
 * a custom reduce merges them per `session_id` (queried with `group=true`). The
 * emitted map value and the reduce output share one shape, so the reduce also works
 * on re-reduce. Ended sessions carry their full rollup in `summary`, so the reader
 * needs no second fetch for them.
 *
 * The reduce output is bounded per session (a fixed-shape object + a small tools
 * map), but CouchDB's `reduce_limit` overflow guard can still reject
 * object-accumulating reduces. The webapi's boot (`ensure.ts`) sets
 * `query_server_config/reduce_limit = false` on the bundled instance for this reason.
 */
import type { DesignDoc } from "./designs";

const AGGREGATE_MAP = `function (doc) {
  if (!doc.session_id) return;
  if (doc.type !== "event" && doc.type !== "summary") return;
  var isSummary = doc.type === "summary";
  var tools = {};
  if (doc.event === "PostToolUse" && doc.tool_name) tools[doc.tool_name] = 1;
  emit(doc.session_id, {
    ended: isSummary ? 1 : 0,
    events: doc.type === "event" ? 1 : 0,
    prompts: doc.event === "UserPromptSubmit" ? 1 : 0,
    errors: doc.event === "PostToolUseFailure" ? 1 : 0,
    started: doc.event === "SessionStart" ? 1 : 0,
    tools: tools,
    first: doc.timestamp || "",
    last: doc.timestamp || "",
    model: (doc.event === "SessionStart" || isSummary) ? (doc.model || "") : "",
    cwd: doc.cwd || "",
    hostname: doc.hostname || "",
    summary: isSummary ? {
      event_count: doc.event_count || 0,
      prompt_count: doc.prompt_count || 0,
      error_count: doc.error_count || 0,
      tool_counts: doc.tool_counts || {},
      end_reason: doc.end_reason || "",
      transcript_bytes: doc.transcript_bytes || 0,
      token_usage: doc.token_usage || null,
      timestamp: doc.timestamp || "",
      source: doc.source || ""
    } : null
  });
}`;

const AGGREGATE_REDUCE = `function (keys, values, rereduce) {
  var acc = { ended:0, events:0, prompts:0, errors:0, started:0, tools:{}, first:"", last:"", model:"", cwd:"", hostname:"", summary:null };
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (!v) continue;
    acc.ended += v.ended || 0;
    acc.events += v.events || 0;
    acc.prompts += v.prompts || 0;
    acc.errors += v.errors || 0;
    acc.started += v.started || 0;
    if (v.last && v.last > acc.last) acc.last = v.last;
    if (v.first && (acc.first === "" || v.first < acc.first)) acc.first = v.first;
    if (v.model) acc.model = v.model;
    if (v.cwd) acc.cwd = v.cwd;
    if (v.hostname) acc.hostname = v.hostname;
    if (v.summary) acc.summary = v.summary;
    var t = v.tools || {};
    for (var k in t) { if (t.hasOwnProperty(k)) acc.tools[k] = (acc.tools[k] || 0) + t[k]; }
  }
  return acc;
}`;

export const SESSION_INDEX_DESIGN: DesignDoc = {
  _id: "_design/session_index",
  language: "javascript",
  views: {
    aggregate: { map: AGGREGATE_MAP, reduce: AGGREGATE_REDUCE },
  },
};

/** The shape of one `aggregate` reduce row's value (mirrors the view above). */
export interface SessionAggregate {
  ended: number;
  events: number;
  prompts: number;
  errors: number;
  started: number;
  tools: Record<string, number>;
  first: string;
  last: string;
  model: string;
  cwd: string;
  hostname: string;
  summary: {
    event_count: number;
    prompt_count: number;
    error_count: number;
    tool_counts: Record<string, number>;
    end_reason: string;
    transcript_bytes: number;
    token_usage: unknown;
    timestamp: string;
    /** Provenance of the ended session: "live" (hook) | "backfill" | "doctor" | … */
    source: string;
  } | null;
}
