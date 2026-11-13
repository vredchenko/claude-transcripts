/**
 * Backfilled subagents: what is found on disk, and the docs it becomes.
 *
 * The fixture is a scratch `~/.claude/projects` holding every layout Claude Code has
 * used for subagents — its own file under `<session>/subagents/` with a meta file, its
 * own file loose beside the sessions, and `isSidechain` lines inside the session file —
 * so each test reads the same tree a real backfill would.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfill } from "../commands/backfill";
import { type DiscoveredTranscript, discoverTranscripts, readTranscript } from "./claude-fs";
import { buildEventDocs } from "./session-docs";
import {
  buildSubagentEventDocs,
  loadSubagents,
  reconstructSubagents,
  withSubagentTools,
} from "./subagents";
import { deriveSessionFacts } from "./transcript";

const NEW = "11111111-1111-4111-8111-111111111111"; // <session>/subagents/ layout
const FLAT = "22222222-2222-4222-8222-222222222222"; // loose agent-*.jsonl layout
const INLINE = "33333333-3333-4333-8333-333333333333"; // isSidechain lines in the session
const CWD = "/srv/proj";
const ts = (s: number) => `2026-08-20T14:00:${String(s).padStart(2, "0")}.000Z`;
const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

const user = (sessionId: string, uuid: string, t: number, content: unknown, extra = {}) => ({
  type: "user",
  sessionId,
  uuid,
  timestamp: ts(t),
  cwd: CWD,
  message: { role: "user", content },
  ...extra,
});
const assistant = (sessionId: string, uuid: string, t: number, content: unknown[], extra = {}) => ({
  type: "assistant",
  sessionId,
  uuid,
  timestamp: ts(t),
  cwd: CWD,
  message: { id: `m-${uuid}`, role: "assistant", model: "claude-test", content },
  ...extra,
});
const toolUse = (id: string, name: string, input: object = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (id: string, text: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content: text,
  ...(isError ? { is_error: true } : {}),
});

/** A subagent's own file: every line `isSidechain` + `agentId`, the parent's sessionId. */
function agentLines(sessionId: string, agentId: string, from: number) {
  const side = { isSidechain: true, agentId };
  return [
    user(sessionId, `${agentId}-u1`, from, "look into it", side),
    assistant(sessionId, `${agentId}-a1`, from + 1, [toolUse(`${agentId}-t1`, "Grep")], side),
    user(sessionId, `${agentId}-u2`, from + 2, [toolResult(`${agentId}-t1`, "found")], side),
    assistant(sessionId, `${agentId}-a2`, from + 3, [toolUse(`${agentId}-t2`, "Read")], side),
    user(sessionId, `${agentId}-u3`, from + 4, [toolResult(`${agentId}-t2`, "ENOENT", true)], side),
    assistant(sessionId, `${agentId}-a3`, from + 5, [{ type: "text", text: "done" }], side),
  ];
}

/** The session line that spawns an agent, and the result that names it. */
function spawn(sessionId: string, agentId: string, t: number, subagentType?: string) {
  const id = `spawn-${agentId}`;
  return [
    assistant(sessionId, `${id}-a`, t, [
      toolUse(id, "Agent", {
        description: "x",
        ...(subagentType ? { subagent_type: subagentType } : {}),
      }),
    ]),
    user(sessionId, `${id}-r`, t + 1, [toolResult(id, "launched")], {
      toolUseResult: { agentId, status: "async_launched" },
    }),
  ];
}

let root = "";
let dir = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-subagents-"));
  dir = join(root, "-srv-proj");
  await mkdir(join(dir, NEW, "subagents"), { recursive: true });

  // Current layout: `<session>/subagents/agent-<id>.jsonl` + `.meta.json`.
  await writeFile(
    join(dir, `${NEW}.jsonl`),
    jsonl([user(NEW, "n-u1", 1, "hello"), ...spawn(NEW, "aaa111", 2)]),
  );
  await writeFile(
    join(dir, NEW, "subagents", "agent-aaa111.jsonl"),
    jsonl(agentLines(NEW, "aaa111", 10)),
  );
  await writeFile(
    join(dir, NEW, "subagents", "agent-aaa111.meta.json"),
    JSON.stringify({ agentType: "Explore", toolUseId: "spawn-aaa111" }),
  );

  // Flat layout: loose beside the sessions, no meta; the type comes from the spawn call.
  await writeFile(
    join(dir, `${FLAT}.jsonl`),
    jsonl([user(FLAT, "f-u1", 1, "hello"), ...spawn(FLAT, "bbb222", 2, "code-reviewer")]),
  );
  await writeFile(join(dir, "agent-bbb222.jsonl"), jsonl(agentLines(FLAT, "bbb222", 20)));
  // A loose agent file whose parent is not on disk: belongs to nothing found here.
  await writeFile(join(dir, "agent-ccc333.jsonl"), jsonl(agentLines("gone", "ccc333", 30)));

  // Oldest layout: sidechain lines inside the session's own file — one with an agent id
  // (and no spawn call naming a type), two without.
  await writeFile(
    join(dir, `${INLINE}.jsonl`),
    jsonl([
      user(INLINE, "i-u1", 1, "hello"),
      ...agentLines(INLINE, "ddd444", 40),
      assistant(INLINE, "old-1", 50, [{ type: "text", text: "a" }], { isSidechain: true }),
      assistant(INLINE, "old-2", 51, [{ type: "text", text: "b" }], { isSidechain: true }),
    ]),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function found(): Promise<Map<string, DiscoveredTranscript>> {
  return new Map((await discoverTranscripts(root)).map((t) => [t.sessionId, t]));
}

async function build(sessionId: string) {
  const t = (await found()).get(sessionId)!;
  const text = await readTranscript(t.path);
  const sub = reconstructSubagents(text, await loadSubagents(t.subagents));
  const facts = withSubagentTools(
    deriveSessionFacts(text, { hostname: "h", sessionIdHint: sessionId }),
    sub,
  );
  return { text, sub, facts, docs: buildSubagentEventDocs(sub, facts, "backfill") };
}

describe("discoverTranscripts", () => {
  test("an agent file is never a session of its own", async () => {
    expect([...(await found()).keys()]).toEqual([NEW, FLAT, INLINE]);
  });

  test("finds both on-disk layouts and attaches them to their parent", async () => {
    const byId = await found();
    expect(byId.get(NEW)?.subagents).toEqual([
      {
        agentId: "aaa111",
        path: join(dir, NEW, "subagents", "agent-aaa111.jsonl"),
        metaPath: join(dir, NEW, "subagents", "agent-aaa111.meta.json"),
      },
    ]);
    expect(byId.get(FLAT)?.subagents).toEqual([
      { agentId: "bbb222", path: join(dir, "agent-bbb222.jsonl") },
    ]);
    expect(byId.get(INLINE)?.subagents).toEqual([]);
  });
});

describe("subagent markers", () => {
  test("a Start/Stop pair shaped like the live hook's, at the first and last line", async () => {
    const { docs } = await build(NEW);
    const start = docs.find((d) => d.event === "SubagentStart");
    const stop = docs.find((d) => d.event === "SubagentStop");
    // Exactly the live marker's fields (hook/handlers.ts) plus the reconstruction tags.
    expect(start).toEqual({
      type: "event",
      event: "SubagentStart",
      session_id: NEW,
      timestamp: ts(10),
      hostname: "h",
      cwd: CWD,
      agent_id: "aaa111",
      agent_type: "Explore",
      reconstructed: true,
      ingest_source: "backfill",
    });
    expect(stop).toMatchObject({ event: "SubagentStop", agent_id: "aaa111", timestamp: ts(15) });
  });

  test("tool calls inside the subagent become tool markers and tool counts", async () => {
    const { docs, facts } = await build(NEW);
    expect(docs.map((d) => d.event)).toEqual([
      "SubagentStart",
      "PostToolUse",
      "PostToolUseFailure",
      "SubagentStop",
    ]);
    expect(docs[1]).toMatchObject({ tool_name: "Grep", tool_use_id: "aaa111-t1" });
    // Live tool markers do not name the agent, so neither do these.
    expect(docs[1]).not.toHaveProperty("agent_id");
    // `Read` failed: like the hook's `tool_counts`, only successful calls are counted.
    expect(facts.toolCounts).toEqual({ Agent: 1, Grep: 1 });
  });

  test("the flat layout, typed by the call that spawned it", async () => {
    const { docs } = await build(FLAT);
    expect(docs.filter((d) => d.event.startsWith("Subagent"))).toEqual([
      expect.objectContaining({
        event: "SubagentStart",
        agent_id: "bbb222",
        agent_type: "code-reviewer",
      }),
      expect.objectContaining({ event: "SubagentStop", agent_id: "bbb222", timestamp: ts(25) }),
    ]);
  });

  test("inline sidechains: markers by agent id; no type is made up; no tool markers twice", async () => {
    const { text, docs, sub, facts } = await build(INLINE);
    expect(sub.unattributed).toBe(2);
    expect(docs.map((d) => d.event)).toEqual(["SubagentStart", "SubagentStop"]);
    expect(docs[0]).toMatchObject({ agent_id: "ddd444", timestamp: ts(40) });
    expect(docs[0]).not.toHaveProperty("agent_type");
    // Their tool markers come from the session's own transcript, already.
    const own = buildEventDocs(text, facts, "backfill").filter((d) =>
      d.event.startsWith("PostTool"),
    );
    expect(own).toHaveLength(2);
    expect(facts.toolCounts).toEqual({ Grep: 1 });
  });

  test("a line in both the session file and the agent file is counted once", async () => {
    const lines = agentLines(NEW, "eee555", 60);
    const session = jsonl([user(NEW, "x", 1, "hi"), ...lines]);
    const sub = reconstructSubagents(session, [{ agentId: "eee555", jsonl: jsonl(lines) }]);
    expect(sub.agents).toEqual([{ agentId: "eee555", start: ts(60), end: ts(65) }]);
    const facts = deriveSessionFacts(session);
    expect(withSubagentTools(facts, sub).toolCounts).toEqual(facts.toolCounts);
  });
});

/** The whole command against a fake webapi: what reaches `/api/ingest/events`, and what it says. */
describe("runBackfill with subagents", () => {
  const events: Record<string, unknown>[] = [];
  const summaries: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return Response.json({ ok: true });
      if (pathname.startsWith("/api/sessions/")) return new Response("nf", { status: 404 });
      type Doc = Record<string, unknown>;
      if (pathname === "/api/ingest/events") {
        events.push(...((await req.json()) as { docs: Doc[] }).docs);
      }
      if (pathname === "/api/ingest/summary") summaries.push((await req.json()) as Doc);
      if (pathname.startsWith("/api/ingest")) return Response.json({ ok: true });
      return new Response("nf", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  test("writes the markers and says what it could not reconstruct", async () => {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    Object.assign(console, { log: capture, warn: capture, error: capture });
    let code: number;
    try {
      code = await runBackfill([
        "--dir",
        root,
        "--host",
        "h",
        "--webapi",
        `http://localhost:${server.port}`,
      ]);
    } finally {
      Object.assign(console, saved);
    }
    expect(code).toBe(0);
    expect(lines).toContain("backfill: 3 transcript(s) found");
    const starts = events.filter((e) => e.event === "SubagentStart").map((e) => e.agent_id);
    expect(starts.sort()).toEqual(["aaa111", "bbb222", "ddd444"]);
    expect(events.filter((e) => e.event === "SubagentStop")).toHaveLength(3);
    const summary = summaries.find((s) => s.session_id === NEW);
    expect(summary?.tool_counts).toEqual({ Agent: 1, Grep: 1 });
    expect(lines.some((l) => l.includes("3 subagent(s) in 3 session(s)"))).toBe(true);
    expect(lines.some((l) => l.includes("own transcript file is not stored"))).toBe(true);
    expect(lines.some((l) => l.includes("2 subagent line(s) carry no agent id"))).toBe(true);
  });
});
