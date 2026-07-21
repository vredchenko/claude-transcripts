/**
 * `claude-transcripts sessions [id]` — list or inspect sessions through the webapi
 * (the read side of the gateway). No id → a recent-sessions table; with an id →
 * session detail + a transcript preview.
 *
 *   claude-transcripts sessions                 # recent sessions
 *   claude-transcripts sessions <id>            # detail + transcript preview
 *   (both accept --limit <n> and --webapi <url>)
 */
import type { SessionSummary } from "@claude-transcripts/shared";
import { getSession, getSessionTranscript, listSessions } from "../api/generated";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";

function num(n: number | undefined): string {
  return (n ?? 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

function project(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd || "—";
}

function tools(counts: Record<string, number> | undefined): number {
  return counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s.padEnd(w);
}

function padL(s: string, w: number): string {
  return s.length >= w ? s : s.padStart(w);
}

function row(cols: [string, number][]): string {
  return cols.map(([s, w], i) => (i >= 4 ? padL(s, w) : pad(s, w))).join("  ");
}

function summaryLine(s: SessionSummary): string {
  return row([
    [s.sessionId.slice(0, 8), 8],
    [(s.timestamp ?? "").replace("T", " ").slice(0, 16), 16],
    [s.status, 10],
    [project(s.cwd), 18],
    [num(s.promptCount), 7],
    [num(tools(s.toolCounts)), 6],
    [s.tokenUsage ? num(s.tokenUsage.total) : "—", 9],
  ]);
}

async function showList(limit: number): Promise<number> {
  const res = await listSessions({ limit });
  console.log(`sessions: ${num(res.totalCount)} total (${webapiUrl()})`);
  if (res.sessions.length === 0) {
    console.log("sessions: none recorded yet");
    return 0;
  }
  console.log(
    row([
      ["SESSION", 8],
      ["STARTED", 16],
      ["STATUS", 10],
      ["PROJECT", 18],
      ["PROMPTS", 7],
      ["TOOLS", 6],
      ["TOKENS", 9],
    ]),
  );
  for (const s of res.sessions) console.log(summaryLine(s));
  return 0;
}

/** Compact one-line description of a raw transcript entry. */
function entryLine(entry: Record<string, unknown>, i: number): string {
  const msg = (entry.message ?? {}) as Record<string, unknown>;
  const kind = String(entry.type ?? msg.role ?? "?");
  let text = "";
  const content = msg.content ?? entry.summary ?? entry.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b: unknown) => {
        const block = (b ?? {}) as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "tool_use") return `⚙ ${String(block.name ?? "tool")}`;
        if (block.type === "tool_result") return "[tool result]";
        if (block.type === "thinking") return "[thinking]";
        return "";
      })
      .join(" ");
  }
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 100);
  return `  ${padL(`#${i}`, 4)}  ${pad(kind, 10)} ${preview}`;
}

async function showDetail(id: string, limit: number): Promise<number> {
  const s = await getSession(id);
  console.log(`session ${s.sessionId}  [${s.status}]`);
  console.log(`  started    ${s.timestamp ?? "—"}`);
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
    console.log(
      `\ntranscript — first ${num(tr.messages.length)} of ${num(tr.totalCount)} entries:`,
    );
    for (const [i, m] of tr.messages.entries()) console.log(entryLine(m, i));
    if (tr.hasMore)
      console.log(`  … (${num(tr.totalCount - tr.messages.length)} more — raise --limit)`);
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

  try {
    return id ? await showDetail(id, limit) : await showList(limit);
  } catch (err) {
    console.error(`sessions: failed — ${(err as Error).message}`);
    console.error(
      `sessions: is the webapi reachable at ${webapiUrl()}? (set --webapi or $CT_WEBAPI_URL)`,
    );
    return 1;
  }
}
