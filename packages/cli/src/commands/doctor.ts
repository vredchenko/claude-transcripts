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
 * It writes one real session tagged `source: "doctor"` with a `doctor-<ts>` id, and
 * **removes it again** — a smoke test that leaves a trail in real history is one people
 * learn not to run. `--keep` leaves it for inspection.
 *
 * Search is checked too, when the feature is on: a corpus you can't search is a broken
 * install even if every write succeeded, and the failure otherwise surfaces the first
 * time a user searches rather than at setup.
 */
import { hostname } from "node:os";
import { getSession, getSessionTranscript, resetSession, search } from "../api/generated";
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

interface HealthResponse {
  ok?: boolean;
  version?: string;
  startedAt?: string;
  stores?: { couch?: { ok?: boolean; error?: string; provisioningError?: string } };
}

/** GET /health, tolerating an older server that predates the stores field. */
async function probeHealth(): Promise<HealthResponse | undefined> {
  try {
    const res = await fetch(`${webapiUrl()}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthResponse;
  } catch {
    return undefined; // unreachable — the write below reports it with more context
  }
}

/** " (up since <time>)" when the server reports its start time. */
function startedSuffix(health: HealthResponse): string {
  return health.startedAt ? ` (up since ${health.startedAt})` : "";
}

/**
 * Wait for the synthetic session to appear in search.
 *
 * Indexing is asynchronous — the webapi follows CouchDB's `_changes` feed — so a check
 * that asserts immediately would fail on a healthy install. Polls for up to ~10s and
 * reports `"disabled"` (a skip, not a failure) when search isn't switched on.
 */
async function pollForSearchHit(sessionId: string): Promise<boolean | "disabled"> {
  const deadline = Date.now() + 10_000;
  let sawEnabled = false;
  while (Date.now() < deadline) {
    const res = await search({ q: sessionId, limit: 20 });
    if (!res.enabled) return "disabled";
    sawEnabled = true;
    if (res.hits.some((h) => h.sessionId === sessionId)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return sawEnabled ? false : "disabled";
}

/**
 * Delete the session doctor just created.
 *
 * `blobs=true` because the transcript is a fixture too — a reset keeps the blob by
 * default (that's right for re-ingest, wrong for a smoke test). Never throws: failing
 * to clean up must not turn a passing diagnosis into a failing one, so it reports and
 * leaves the id.
 */
async function cleanUp(sessionId: string): Promise<void> {
  try {
    const res = await resetSession(sessionId, { blobs: "true" });
    const d = res.deleted;
    console.log(
      `doctor: cleaned up ${sessionId} (${d.summary} summary, ${d.events} events, ` +
        `${d.chunks} chunks, ${d.blobs} blob)`,
    );
  } catch (err) {
    console.error(`doctor: could not clean up ${sessionId} — ${(err as Error).message}`);
    console.error(`doctor: remove it by hand if it matters: DELETE /api/ingest/${sessionId}`);
  }
}

export async function runDoctor(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const sink = makeSink({ dryRun: false, webapiUrl: strOpt(options, "webapi") });
  // `--keep` leaves the session behind, for when a failure needs inspecting.
  const keep = options.keep === true;

  const sessionId = `doctor-${Date.now()}`;
  const host = hostname();
  const cwd = "/tmp/claude-transcripts-doctor";
  const ts = new Date().toISOString();

  console.log(`doctor: smoke-testing ${sink.label}`);

  // Identify the server BEFORE writing to it. A stale container left listening on
  // the port answers happily and looks like the code you just changed; and if its
  // stores are missing, saying so here beats an opaque failure mid-write.
  const health = await probeHealth();
  if (health) {
    console.log(`doctor: webapi version ${health.version}${startedSuffix(health)}`);
    const couch = health.stores?.couch;
    if (couch && !couch.ok) {
      console.error(`doctor: STORE NOT READY — ${couch.error ?? "CouchDB unavailable"}`);
      if (couch.provisioningError) {
        console.error(`doctor: boot-time provisioning failed — ${couch.provisioningError}`);
      }
      console.error(
        "doctor: fix the store first (is CouchDB up? do the credentials match?), " +
          "then restart the webapi so it can create the databases.",
      );
      return 1;
    }
  }

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
    // A partial write still left docs behind — clear them rather than leaving a
    // half-written session that later reads as `incomplete`.
    if (!keep) await cleanUp(sessionId);
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
    if (!keep) await cleanUp(sessionId);
    return 1;
  }

  // ── Search ───────────────────────────────────────────────────────────────────
  // Indexing is asynchronous (the webapi follows CouchDB's change feed), so poll
  // briefly rather than asserting immediately — and treat "search is off" as a skip,
  // not a failure, because it's an optional feature.
  try {
    const found = await pollForSearchHit(sessionId);
    if (found === "disabled") {
      console.log("  – search — skipped (Meilisearch disabled or unconfigured)");
    } else {
      checks.push({
        name: "session is searchable",
        ok: found,
        detail: found ? undefined : "not indexed within 10s — is Meilisearch reachable?",
      });
    }
  } catch (err) {
    checks.push({
      name: "session is searchable",
      ok: false,
      detail: (err as Error).message,
    });
  }

  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  // Clean up whether or not the checks passed: a failed run is exactly when someone
  // re-runs, and a leftover session would then collide with the next one's id-based
  // assertions — quite apart from leaving debris in real history.
  if (keep) {
    console.log(`doctor: --keep — left ${sessionId} in place`);
  } else {
    await cleanUp(sessionId);
  }
  if (failed > 0) {
    console.error(`doctor: ${failed}/${checks.length} check(s) FAILED`);
    return 1;
  }
  console.log(
    `doctor: OK — ${checks.length}/${checks.length} checks passed (write→store→read verified)`,
  );
  return 0;
}
