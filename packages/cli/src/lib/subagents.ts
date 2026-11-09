/**
 * The subagents of a backfilled session, reconstructed as the live hook records them.
 *
 * What the live hook writes for a subagent (hook/handlers.ts), and so all backfill writes:
 *  - a `SubagentStart` and a `SubagentStop` event marker — the common fields plus
 *    `agent_id` and `agent_type`;
 *  - a `PostToolUse` / `PostToolUseFailure` marker for each tool call the subagent makes
 *    (Claude Code fires tool hooks inside subagents too), counted into the summary's
 *    `tool_counts` like any other. Those markers do not name the agent, live or here;
 *  - nothing else. `SubagentStop` carries `agent_transcript_path`, but the hook never
 *    reads it, so a subagent's own transcript file reaches neither chunks nor S3.
 *
 * Where the subagents come from, by Claude Code version (see claude-fs.ts):
 *  - their own `agent-<agentId>.jsonl` files — every line `isSidechain` + `agentId`,
 *    with `agent-<agentId>.meta.json` (`agentType`) beside the newer ones;
 *  - older versions: `isSidechain` lines inside the session's own transcript. Those are
 *    already in its chunks and its tool markers (`buildEventDocs` reads every assistant
 *    line); what is added here is only the Start/Stop pair, grouped by `agentId`.
 *
 * What cannot be reconstructed, and is therefore left out rather than made up:
 *  - marker times are the subagent's first and last transcript line, not the moments the
 *    hooks fired (the same approximation every backfilled marker makes);
 *  - `SubagentStop` is written for every subagent found: a transcript does not record
 *    whether one finished or was cut off (as backfill writes a summary for every session);
 *  - `agent_type` is omitted when neither a meta file nor the spawning tool call names it;
 *  - sidechain lines with no `agentId` (the oldest transcripts) get no markers at all:
 *    `agent_id` is the field the live marker always has, and there is nothing to fill it
 *    with. They are counted as `unattributed` so the run can say so.
 */
import { readFile } from "node:fs/promises";
import type { SubagentFile } from "./claude-fs";
import { buildEventDocs, type EventDoc, type IngestSource } from "./session-docs";
import { deriveSessionFacts, parseEntries, type SessionFacts } from "./transcript";

/** A subagent file as read off disk. */
export interface LoadedSubagent {
  agentId: string;
  jsonl: string;
  /** From `agent-<id>.meta.json`; upstream-owned, read loosely. */
  meta?: { agentType?: unknown; toolUseId?: unknown };
}

/**
 * Read a session's subagent files. A transcript that cannot be read throws, so the
 * session fails and is retried on the next run rather than adopted without it; a meta
 * file is optional, and an unreadable one is treated as absent.
 */
export async function loadSubagents(files: SubagentFile[]): Promise<LoadedSubagent[]> {
  const out: LoadedSubagent[] = [];
  for (const f of files) {
    const jsonl = await readFile(f.path, "utf8");
    let meta: LoadedSubagent["meta"];
    if (f.metaPath) {
      try {
        meta = JSON.parse(await readFile(f.metaPath, "utf8"));
      } catch {
        meta = undefined;
      }
    }
    out.push({ agentId: f.agentId, jsonl, ...(meta ? { meta } : {}) });
  }
  return out;
}

export interface Subagent {
  agentId: string;
  agentType?: string;
  /** first and last line's timestamp */
  start?: string;
  end?: string;
  /**
   * The subagent's lines that are *not* in the session's own transcript — the ones its
   * tool markers still have to come from. Absent for an inline (sidechain) subagent.
   */
  ownJsonl?: string;
}

export interface SubagentReconstruction {
  /** ordered by start time */
  agents: Subagent[];
  /** sidechain lines in the session transcript with no `agentId` — see the module doc */
  unattributed: number;
}

export function reconstructSubagents(
  sessionJsonl: string,
  loaded: LoadedSubagent[],
): SubagentReconstruction {
  const main = parseEntries(sessionJsonl);
  const typeOf = spawnedTypes(main);
  const byId = new Map<string, Subagent>();
  const touch = (agentId: string, ts: unknown): Subagent => {
    let a = byId.get(agentId);
    if (!a) {
      a = { agentId };
      byId.set(agentId, a);
    }
    if (typeof ts === "string" && ts) {
      if (!a.start || ts < a.start) a.start = ts;
      if (!a.end || ts > a.end) a.end = ts;
    }
    return a;
  };

  let unattributed = 0;
  for (const e of main) {
    if (e.isSidechain !== true) continue;
    if (typeof e.agentId === "string" && e.agentId) touch(e.agentId, e.timestamp);
    else unattributed++;
  }

  // A line that is in both places is the session transcript's: its tool markers are
  // already built from there, and building them again would double them.
  const inSession = new Set(main.map((e) => e.uuid));
  for (const sub of loaded) {
    const own = parseEntries(sub.jsonl).filter(
      (e) => e.uuid === undefined || !inSession.has(e.uuid),
    );
    const a = touch(sub.agentId, undefined);
    for (const e of own) touch(sub.agentId, e.timestamp);
    if (own.length) a.ownJsonl = own.map((e) => JSON.stringify(e)).join("\n");
    const metaType = sub.meta?.agentType;
    if (typeof metaType === "string" && metaType) a.agentType = metaType;
    const viaTool = sub.meta?.toolUseId;
    if (!a.agentType && typeof viaTool === "string") a.agentType = typeOf.byToolUse.get(viaTool);
  }

  for (const a of byId.values()) {
    if (!a.agentType) a.agentType = typeOf.byAgent.get(a.agentId);
    if (!a.agentType) delete a.agentType;
  }
  const agents = [...byId.values()].sort(
    (x, y) => (x.start ?? "").localeCompare(y.start ?? "") || x.agentId.localeCompare(y.agentId),
  );
  return { agents, unattributed };
}

/**
 * `subagent_type` as the spawning tool call asked for it: by tool_use id, and by agent id
 * where the tool result names the agent it started (`toolUseResult.agentId`).
 */
function spawnedTypes(main: ReturnType<typeof parseEntries>): {
  byToolUse: Map<string, string>;
  byAgent: Map<string, string>;
} {
  const byToolUse = new Map<string, string>();
  const agentToolUse = new Map<string, string>();
  for (const e of main) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const type = item?.input?.subagent_type;
      if (item?.type === "tool_use" && typeof item.id === "string" && typeof type === "string") {
        byToolUse.set(item.id, type);
      }
      // `any`: upstream-owned result shape.
      const agentId = (e.toolUseResult as any)?.agentId;
      if (
        item?.type === "tool_result" &&
        typeof item.tool_use_id === "string" &&
        typeof agentId === "string"
      ) {
        agentToolUse.set(agentId, item.tool_use_id);
      }
    }
  }
  const byAgent = new Map<string, string>();
  for (const [agentId, toolUseId] of agentToolUse) {
    const type = byToolUse.get(toolUseId);
    if (type) byAgent.set(agentId, type);
  }
  return { byToolUse, byAgent };
}

/**
 * The marker docs the live hook would have written for these subagents: a
 * `SubagentStart`/`SubagentStop` pair each, and the tool markers of the lines that live
 * only in the subagent's own file (those are built exactly as the session's own are).
 */
export function buildSubagentEventDocs(
  r: SubagentReconstruction,
  facts: SessionFacts,
  source: IngestSource,
): EventDoc[] {
  const mk = (event: string, a: Subagent, timestamp: string | undefined): EventDoc => ({
    type: "event",
    event,
    session_id: facts.sessionId,
    timestamp: timestamp ?? facts.startTimestamp ?? "",
    hostname: facts.hostname,
    cwd: facts.cwd,
    reconstructed: true,
    ingest_source: source,
    agent_id: a.agentId,
    ...(a.agentType ? { agent_type: a.agentType } : {}),
  });
  const docs: EventDoc[] = [];
  for (const a of r.agents) {
    docs.push(mk("SubagentStart", a, a.start));
    if (a.ownJsonl) {
      docs.push(
        ...buildEventDocs(a.ownJsonl, facts, source).filter(
          (d) => d.event === "PostToolUse" || d.event === "PostToolUseFailure",
        ),
      );
    }
    docs.push(mk("SubagentStop", a, a.end));
  }
  return docs;
}

/**
 * The session's facts with the subagents' own tool calls added to `toolCounts`, as the
 * live hook's counters include them. Inline sidechain calls are already counted.
 */
export function withSubagentTools(facts: SessionFacts, r: SubagentReconstruction): SessionFacts {
  const toolCounts = { ...facts.toolCounts };
  for (const a of r.agents) {
    if (!a.ownJsonl) continue;
    for (const [tool, n] of Object.entries(deriveSessionFacts(a.ownJsonl).toolCounts)) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + n;
    }
  }
  return { ...facts, toolCounts };
}
