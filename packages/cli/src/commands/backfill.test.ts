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
import { planReingest, type ReingestPlan, runBackfill } from "./backfill";

const live = { source: "live", status: "ended" };
const backfilled = { source: "backfill" };
const running = { source: "live", status: "running" };

const NO = { force: false, replaceLive: false };
const FORCE = { force: true, replaceLive: false };
const REPAIR = { force: false, replaceLive: false, repair: true };
const adopt: ReingestPlan = { action: "adopt" };
const skip = (reason: Extract<ReingestPlan, { action: "skip" }>["reason"]): ReingestPlan => ({
  action: "skip",
  reason,
});

describe("planReingest", () => {
  test.each([
    ["nothing stored is adopted", null, NO, adopt],
    ["an adopted session is skipped without --force", backfilled, NO, skip("already-adopted")],
    ["--force rebuilds a reconstruction", backfilled, FORCE, adopt],
    ["--force alone refuses a live record", live, FORCE, skip("live-record")],
    ["--replace-live opts in to replacing it", live, { ...FORCE, replaceLive: true }, adopt],
    // --replace-live widens what --force may overwrite; on its own it widens nothing.
    ["--replace-live without --force", live, { ...NO, replaceLive: true }, skip("already-adopted")],
    // Only `live` carries irreplaceable provenance; a future source must opt in.
    ["an unknown source is rebuildable", { source: "doctor" }, FORCE, adopt],
  ] as const)("%s", (_name, existing, opts, plan) => {
    expect(planReingest(existing, opts)).toEqual(plan);
  });
});

/**
 * `--repair` is the additive counterpart: it adds the chunk docs a misconfigured hook
 * never wrote, and touches neither the summary nor the event markers. Its refusals are
 * what keep it additive.
 */
describe("planReingest, --repair", () => {
  test.each([
    // A cancelled SessionEnd finishes the CouchDB writes and dies before the upload, so
    // the chunks are intact and the verbatim copy never landed — readable through the
    // API, which is why nothing noticed.
    [
      "chunks intact, no blob → blob only",
      live,
      { hasTurns: true, hasBlob: false },
      { action: "repair-blob" },
    ],
    // Chunk ids are byte offsets; the hook's will not line up with a whole-file
    // partition, so writing over a partially-chunked session leaves both sets.
    [
      "turns and a blob → nothing missing",
      live,
      { hasTurns: true, hasBlob: true },
      skip("has-turns"),
    ],
    ["no turn content → full repair", live, { hasTurns: false }, { action: "repair" }],
    [
      "running → left alone, even with no blob",
      running,
      { hasTurns: true, hasBlob: false },
      skip("running"),
    ],
    ["running → left alone with no turns", running, { hasTurns: false }, skip("running")],
    ["nothing stored → adopted, not repaired", null, { hasTurns: false }, adopt],
  ] as const)("%s", (_name, existing, facts, plan) => {
    expect(planReingest(existing, { ...REPAIR, ...facts })).toEqual(plan);
  });

  test("without --repair, an adopted session with no turns is still just skipped", () => {
    expect(planReingest(live, { ...NO, hasTurns: false })).toEqual(skip("already-adopted"));
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

  test("no NOTE about reconstruction when nothing was backfilled", async () => {
    stored.add("s-one");
    stored.add("s-two");
    const { code, lines } = await run("--webapi", LIVE);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("0 backfilled, 2 skipped"))).toBe(true);
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
