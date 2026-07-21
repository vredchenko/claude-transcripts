/**
 * End-to-end suite (testing.md, the Tier-1 → Tier-2 gate).
 *
 * Fakes Claude Code sessions and drives the whole write → store → read path through
 * the real webapi gateway (ingest endpoints → CouchDB + S3; then the reader
 * endpoints), asserting each session reads back correctly. Scenarios cover a
 * baseline session, a large session that spans multiple transcript chunks, and one
 * with subagent (sidechain) sub-transcript entries.
 *
 * Requires the bundled stack + webapi to be up. It **self-skips** (never fails)
 * when the webapi is unreachable, so it's safe anywhere; CI runs it against the dev
 * stack. Point it elsewhere with `CT_WEBAPI_URL`.
 *
 *   bun run stack:up && bun run dev:webapi   # in one shell
 *   bun run test:e2e                          # in another
 */
import { describe, expect, test } from "bun:test";
import { type SynthSession, synthSession } from "./synth";

const BASE = (process.env.CT_WEBAPI_URL ?? "http://127.0.0.1:7650").replace(/\/$/, "");

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const UP = await reachable();
const it = UP ? test : test.skip;
if (!UP) {
  console.warn(
    `[e2e] webapi not reachable at ${BASE} — skipping HTTP checks. Start it with ` +
      "`bun run stack:up` + `bun run dev:webapi`, or set CT_WEBAPI_URL.",
  );
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

/** Drive the write path exactly as the host-side CLI/hook would. */
async function ingest(s: SynthSession): Promise<void> {
  await postJson("/api/ingest/summary", s.summaryDoc);
  await postJson("/api/ingest/events", { docs: s.eventDocs });
  await postJson("/api/ingest/chunks", { docs: s.chunkDocs });
  const res = await fetch(`${BASE}/api/ingest/${s.sessionId}/transcript`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson" },
    body: s.transcript,
  });
  if (!res.ok) throw new Error(`PUT transcript → ${res.status}`);
}

/** Read the session back through the gateway and assert it matches the synth. */
async function assertRoundTrip(s: SynthSession): Promise<void> {
  const detail = await getJson(`/api/sessions/${s.sessionId}`);
  expect(detail.sessionId).toBe(s.sessionId);
  expect(detail.status).toBe("ended");
  expect(detail.eventCount).toBe(s.expected.eventCount);
  expect(detail.promptCount).toBe(s.expected.promptCount);
  expect(detail.errorCount).toBe(s.expected.errorCount);
  expect(detail.toolCounts).toEqual(s.expected.toolCounts);
  expect(detail.tokenUsage?.total).toBe(s.expected.tokenTotal);
  expect(detail.hasTranscript).toBe(true);
  expect(detail.transcriptSize).toBe(s.expected.transcriptBytes);

  const tr = await getJson(`/api/sessions/${s.sessionId}/transcript?limit=10000`);
  expect(tr.totalCount).toBe(s.expected.entryCount);
  expect(tr.messages.length).toBe(s.expected.entryCount);
  expect(tr.hasMore).toBe(false);
}

const run = Date.now();
const baseline = synthSession({ sessionId: `e2e-base-${run}` });
// 150 prompts → 300 transcript entries → spans >1 chunk (200 entries/chunk).
const large = synthSession({ sessionId: `e2e-large-${run}`, prompts: 150, tools: {}, errors: 0 });
// Subagent sub-transcript entries: counted in the transcript, not in the rollups.
const subagent = synthSession({
  sessionId: `e2e-subagent-${run}`,
  prompts: 2,
  tools: { Bash: 1 },
  errors: 0,
  sidechains: 3,
});
// Written WITHOUT a summary doc (crashed before SessionEnd) — its old synth
// timestamp makes it stale, so it should surface as `incomplete`.
const incomplete = synthSession({
  sessionId: `e2e-incomplete-${run}`,
  prompts: 1,
  tools: {},
  errors: 0,
});

describe("e2e: synthesized session round-trips", () => {
  it("baseline session", async () => {
    await ingest(baseline);
    await assertRoundTrip(baseline);
  });

  it("large session spanning multiple transcript chunks", async () => {
    await ingest(large);
    await assertRoundTrip(large);
  });

  it("session with subagent (sidechain) sub-transcript entries", async () => {
    await ingest(subagent);
    await assertRoundTrip(subagent);
    // sidechain entries inflate the transcript but not the main rollups
    expect(subagent.expected.entryCount).toBe(2 * 2 + 3);
    expect(subagent.expected.promptCount).toBe(2);
  });

  it("incomplete session (events + transcript, no summary) is surfaced", async () => {
    // Write the event markers + transcript, but deliberately NOT the summary doc.
    await postJson("/api/ingest/events", { docs: incomplete.eventDocs });
    const res = await fetch(`${BASE}/api/ingest/${incomplete.sessionId}/transcript`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson" },
      body: incomplete.transcript,
    });
    if (!res.ok) throw new Error(`PUT transcript → ${res.status}`);

    const detail = await getJson(`/api/sessions/${incomplete.sessionId}`);
    expect(detail.status).toBe("incomplete"); // stale synth timestamp → not "running"
    expect(detail.promptCount).toBe(incomplete.expected.promptCount);
    expect(detail.eventCount).toBe(incomplete.expected.eventCount);

    const list = await getJson("/api/sessions?limit=500");
    const found = list.sessions.some(
      (x: { sessionId: string }) => x.sessionId === incomplete.sessionId,
    );
    expect(found).toBe(true);
  });

  it("summary re-ingest is idempotent", async () => {
    const again = await postJson("/api/ingest/summary", baseline.summaryDoc);
    expect(again.ok).toBe(true);
    expect(again.updated).toBe(true); // second write carries _rev forward
  });

  it("lists the baseline session", async () => {
    const list = await getJson("/api/sessions?limit=500");
    const found = list.sessions.some(
      (x: { sessionId: string }) => x.sessionId === baseline.sessionId,
    );
    expect(found).toBe(true);
  });
});

// Pure synth invariant — runs even without the stack, so the file always has a
// non-skipped assertion that the "large" scenario really exercises >1 chunk.
test("synth: large scenario spans more than one chunk", () => {
  expect(large.expected.chunkCount).toBeGreaterThan(1);
});
