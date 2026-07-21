/**
 * `claude-transcripts doctor` — smoke-test the write → store → read path end-to-end.
 *
 * Synthesizes a tiny session, drives it through the **real** ingest path (the same
 * `deriveSessionFacts` + doc builders + webapi sink that `backfill` uses), then
 * reads it back through the gateway and asserts the rollups round-trip. Exit 0 = all
 * checks passed. This is the interactive sibling of the `tests/e2e` suite.
 *
 *   claude-transcripts doctor [--webapi <url>]
 *
 * It writes one real (append-only) session tagged `source: "doctor"` with a
 * `doctor-<ts>` id — a harmless diagnostic record (there is no delete endpoint yet).
 */
import { hostname } from "node:os";
import { getSession, getSessionTranscript } from "../api/generated";
import { webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";
import { buildChunkDocs, buildEventDocs, buildSummaryDoc } from "../lib/session-docs";
import { makeSink } from "../lib/sink";
import { deriveSessionFacts } from "../lib/transcript";

/** A small, realistic CC transcript: a prompt, a tool call + result, a reply. */
function buildTranscript(sessionId: string, cwd: string, ts: string): string {
  const usage = {
    input_tokens: 120,
    output_tokens: 60,
    cache_creation_input_tokens: 15,
    cache_read_input_tokens: 8,
  };
  const base = { sessionId, cwd, timestamp: ts };
  const entries: Record<string, unknown>[] = [
    { ...base, type: "user", uuid: "d1", message: { role: "user", content: "run the smoke test" } },
    {
      ...base,
      type: "assistant",
      uuid: "d2",
      message: {
        id: "dm1",
        role: "assistant",
        model: "claude-opus-4-8",
        usage,
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "echo ok" } }],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "d3",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false, content: "ok" }],
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: "d4",
      message: {
        id: "dm2",
        role: "assistant",
        model: "claude-opus-4-8",
        usage,
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function eq(name: string, got: unknown, want: unknown): Check {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return {
    name,
    ok,
    detail: ok ? undefined : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  };
}

export async function runDoctor(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const sink = makeSink({ dryRun: false, webapiUrl: strOpt(options, "webapi") });

  const sessionId = `doctor-${Date.now()}`;
  const host = hostname();
  const cwd = "/tmp/claude-transcripts-doctor";
  const ts = new Date().toISOString();

  console.log(`doctor: smoke-testing ${sink.label}`);
  console.log(`doctor: synthetic session ${sessionId}`);

  const jsonl = buildTranscript(sessionId, cwd, ts);
  const facts = deriveSessionFacts(jsonl, { hostname: host, sessionIdHint: sessionId });
  const expectedLines = jsonl.split("\n").filter((l) => l.trim().length > 0).length;

  // ── Write (real ingest path) ────────────────────────────────────────────────
  try {
    await sink.putSummary(buildSummaryDoc(facts, "doctor"));
    await sink.putEvents(buildEventDocs(jsonl, facts, "doctor"));
    await sink.putChunks(buildChunkDocs(jsonl, facts, "doctor"));
    await sink.putTranscript(sessionId, new TextEncoder().encode(jsonl));
    console.log("doctor: wrote summary + events + chunks + transcript");
  } catch (err) {
    console.error(`doctor: WRITE FAILED — ${(err as Error).message}`);
    console.error(
      `doctor: is the webapi reachable at ${webapiUrl()} with the sessions DB + bucket provisioned?`,
    );
    return 1;
  }

  // ── Read back + verify ───────────────────────────────────────────────────────
  const checks: Check[] = [];
  try {
    const detail = await getSession(sessionId);
    checks.push(eq("status is ended", detail.status, "ended"));
    checks.push(eq("prompt count", detail.promptCount, facts.promptCount));
    checks.push(eq("event count", detail.eventCount, facts.eventCount));
    checks.push(eq("tool counts", detail.toolCounts, facts.toolCounts));
    checks.push(eq("token total", detail.tokenUsage?.total, facts.tokenUsage.total));
    checks.push(eq("has transcript", detail.hasTranscript, true));
    checks.push(eq("transcript size", detail.transcriptSize, facts.transcriptBytes));

    const transcript = await getSessionTranscript(sessionId, { limit: 1000 });
    checks.push(eq("transcript entries", transcript.totalCount, expectedLines));
  } catch (err) {
    console.error(`doctor: READ FAILED — ${(err as Error).message}`);
    return 1;
  }

  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  if (failed > 0) {
    console.error(`doctor: ${failed}/${checks.length} check(s) FAILED`);
    return 1;
  }
  console.log(
    `doctor: OK — ${checks.length}/${checks.length} checks passed (write→store→read verified)`,
  );
  return 0;
}
