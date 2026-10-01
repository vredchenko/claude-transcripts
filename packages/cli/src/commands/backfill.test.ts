/**
 * `backfill --force`'s refusal to downgrade a live-recorded session.
 *
 * The case worth guarding is destructive and unrecoverable: `resetSession` deletes the
 * summary and every event marker *before* anything is rebuilt, so a wrong decision here
 * cannot be undone from inside the command. `--force` was written to redo a
 * reconstruction — a `source: "live"` record was written by the hook as the session
 * happened and carries provenance (`end_reason`, model, token usage, real per-event
 * markers) that the transcript cannot yield again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planReingest, runBackfill } from "./backfill";

const live = { source: "live" };
const backfilled = { source: "backfill" };
const running = { source: "live", status: "running" };

describe("planReingest", () => {
  test("a session with nothing stored is adopted", () => {
    expect(planReingest(null, { force: false, replaceLive: false })).toEqual({ action: "adopt" });
  });

  test("--force is not needed to adopt something new", () => {
    expect(planReingest(null, { force: true, replaceLive: false })).toEqual({ action: "adopt" });
  });

  test("an already-adopted session is skipped without --force", () => {
    expect(planReingest(backfilled, { force: false, replaceLive: false })).toEqual({
      action: "skip",
      reason: "already-adopted",
    });
  });

  test("--force rebuilds a reconstruction, which is what it is for", () => {
    expect(planReingest(backfilled, { force: true, replaceLive: false })).toEqual({
      action: "adopt",
    });
  });

  test("--force alone refuses a live record rather than replacing it", () => {
    expect(planReingest(live, { force: true, replaceLive: false })).toEqual({
      action: "skip",
      reason: "live-record",
    });
  });

  test("--replace-live opts in to replacing a live record", () => {
    expect(planReingest(live, { force: true, replaceLive: true })).toEqual({ action: "adopt" });
  });

  test("a live record is still skipped as already-adopted without --force", () => {
    // --replace-live widens what --force may overwrite; on its own it widens nothing.
    expect(planReingest(live, { force: false, replaceLive: true })).toEqual({
      action: "skip",
      reason: "already-adopted",
    });
  });

  test("an unknown source is treated as rebuildable, not as live", () => {
    // Only `live` carries irreplaceable provenance; a future source that does must opt
    // in here deliberately rather than inherit the guard by accident.
    expect(planReingest({ source: "doctor" }, { force: true, replaceLive: false })).toEqual({
      action: "adopt",
    });
  });
});

/**
 * `--repair` is the additive counterpart: it adds the chunk docs a misconfigured hook
 * never wrote, and touches neither the summary nor the event markers. Its refusals are
 * what keep it additive.
 */
describe("planReingest, --repair", () => {
  const repair = { force: false, replaceLive: false, repair: true };

  // A cancelled SessionEnd finishes the CouchDB writes and dies before the upload, so
  // the chunks are intact and the verbatim copy never landed. The session reads fine
  // through the API — `hasTranscript` is true when *either* exists — which is why
  // nothing noticed, and why --repair used to walk away from the one thing it could fix.
  test("chunks intact but no blob is repairable — blob only, no chunk rewrite", () => {
    expect(
      planReingest(
        { source: "live", status: "ended" },
        { ...repair, hasTurns: true, hasBlob: false },
      ),
    ).toEqual({ action: "repair-blob" });
  });

  test("turns AND a blob is still out of scope — nothing is missing", () => {
    expect(
      planReingest(
        { source: "live", status: "ended" },
        { ...repair, hasTurns: true, hasBlob: true },
      ),
    ).toEqual({ action: "skip", reason: "has-turns" });
  });

  test("a running session is left alone even with no blob — the transcript is still moving", () => {
    expect(
      planReingest(
        { source: "live", status: "running" },
        { ...repair, hasTurns: true, hasBlob: false },
      ),
    ).toEqual({ action: "skip", reason: "running" });
  });

  test("no turns still means a full repair, blob or not", () => {
    expect(
      planReingest(
        { source: "live", status: "ended" },
        { ...repair, hasTurns: false, hasBlob: false },
      ),
    ).toEqual({ action: "repair" });
  });

  test("an adopted session with no turn content is repaired", () => {
    expect(planReingest(live, { ...repair, hasTurns: false })).toEqual({ action: "repair" });
  });

  test("a backfilled session with no turn content is repaired too", () => {
    // `--no-content`, or an older CLI that wrote byte-range-only chunks, leaves the same
    // shape: a good record with nothing readable in it.
    expect(planReingest(backfilled, { ...repair, hasTurns: false })).toEqual({
      action: "repair",
    });
  });

  test("a session that already has turns is left alone", () => {
    // Chunk ids are keyed by byte offset; the hook's offsets will not line up with a
    // whole-file partition, so writing over a partially-chunked session leaves both sets.
    expect(planReingest(live, { ...repair, hasTurns: true })).toEqual({
      action: "skip",
      reason: "has-turns",
    });
  });

  test("a running session is left alone — its transcript is still moving", () => {
    expect(planReingest(running, { ...repair, hasTurns: false })).toEqual({
      action: "skip",
      reason: "running",
    });
  });

  test("a running session is skipped as running even if it somehow has turns", () => {
    expect(planReingest(running, { ...repair, hasTurns: true })).toEqual({
      action: "skip",
      reason: "running",
    });
  });

  test("a session with nothing stored is adopted normally, not repaired", () => {
    expect(planReingest(null, { ...repair, hasTurns: false })).toEqual({ action: "adopt" });
  });

  test("without --repair, an adopted session with no turns is still just skipped", () => {
    expect(planReingest(live, { force: false, replaceLive: false, hasTurns: false })).toEqual({
      action: "skip",
      reason: "already-adopted",
    });
  });
});

/**
 * What `runBackfill` says when the webapi is not there (#126), and what it stops saying
 * when nothing was built. Run end to end against a scratch projects dir: the point is
 * the output a user reads, in the order they read it.
 */
describe("runBackfill output", () => {
  // Port 1: nothing listens there, so the connection is refused at once.
  const DEAD = "http://127.0.0.1:1";
  const HINT = `backfill: is the webapi reachable at ${DEAD}? (set --webapi or $CT_WEBAPI_URL)`;
  const NOTE = "backfill: NOTE";

  /** Sessions the fake webapi already holds. */
  const stored = new Set<string>();
  /** Status every ingest write answers with. */
  let ingestStatus = 200;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return Response.json({ ok: true });
      const m = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (m?.[1]) {
        return stored.has(m[1])
          ? Response.json({ sessionId: m[1], source: "backfill", status: "ended" })
          : new Response("not found", { status: 404 });
      }
      if (pathname.startsWith("/api/ingest")) {
        return ingestStatus === 200
          ? Response.json({ ok: true })
          : Response.json({ error: "boom" }, { status: ingestStatus });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const LIVE = `http://localhost:${server.port}`;

  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ct-backfill-"));
    await mkdir(join(root, "-srv-proj"));
    for (const id of ["s-one", "s-two"]) {
      const line = {
        type: "user",
        sessionId: id,
        uuid: `${id}-u1`,
        timestamp: "2026-08-20T14:03:11.000Z",
        cwd: "/srv/proj",
        message: { role: "user", content: "hello" },
      };
      await writeFile(join(root, "-srv-proj", `${id}.jsonl`), `${JSON.stringify(line)}\n`);
    }
  });
  afterAll(async () => {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    stored.clear();
    ingestStatus = 200;
  });

  /** Every line the command printed, on any stream, in order. */
  async function run(...args: string[]): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      const code = await runBackfill(["--dir", root, "--host", "test-host", ...args]);
      return { code, lines };
    } finally {
      Object.assign(console, saved);
    }
  }

  test("unreachable: each failure is listed, the URL and remedy are said once", async () => {
    const { code, lines } = await run("--webapi", DEAD);
    expect(code).toBe(1);
    expect(lines.filter((l) => l.startsWith("  ! "))).toHaveLength(2);
    expect(lines.filter((l) => l === HINT)).toHaveLength(1);
    // After the summary, so it is the last thing on screen.
    expect(lines.indexOf(HINT)).toBeGreaterThan(lines.findIndex((l) => l.includes("2 failed")));
  });

  test("a failure the webapi answered gets no reachability hint", async () => {
    ingestStatus = 500;
    const { code, lines } = await run("--webapi", LIVE);
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
    expect(lines.some((l) => l.includes("is the webapi reachable"))).toBe(false);
  });

  test("dry-run, unreachable: says so once, with the URL, before any plan", async () => {
    const { code, lines } = await run("--dry-run", "--webapi", DEAD);
    expect(code).toBe(0);
    expect(lines.filter((l) => l.includes("WARNING"))).toHaveLength(1);
    expect(lines.filter((l) => l === HINT)).toHaveLength(1);
    const firstPlan = lines.findIndex((l) => l.startsWith("  [dry-run]"));
    expect(firstPlan).toBeGreaterThan(lines.indexOf(HINT));
  });

  test("dry-run, reachable: no unreachable warning", async () => {
    const { lines } = await run("--dry-run", "--webapi", LIVE);
    expect(lines.some((l) => l.includes("unreachable") || l.includes("WARNING"))).toBe(false);
  });

  test("no NOTE about reconstruction when nothing was backfilled", async () => {
    stored.add("s-one");
    stored.add("s-two");
    const { code, lines } = await run("--webapi", LIVE);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("0 backfilled, 2 skipped"))).toBe(true);
    expect(lines.some((l) => l.startsWith(NOTE))).toBe(false);
  });

  test("no NOTE when every session failed", async () => {
    const { lines } = await run("--webapi", DEAD);
    expect(lines.some((l) => l.startsWith(NOTE))).toBe(false);
  });

  test("the NOTE still follows a run that built something", async () => {
    stored.add("s-one");
    const { code, lines } = await run("--webapi", LIVE);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("1 backfilled"))).toBe(true);
    expect(lines.some((l) => l.startsWith(NOTE))).toBe(true);
  });
});
