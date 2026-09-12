/**
 * `sessions`' list filters, asserted against a real request.
 *
 * The thing worth testing is not the formatting but *whether the flag leaves the
 * process*: the same four attributes were live in the webui for months as chips that
 * rendered, were deletable, and were never put in the query string. A filter that
 * parses and then evaporates looks identical to one that works until you count the
 * rows, so these tests read the URL the CLI actually asked for.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionSummary } from "../api/generated";
import { runSessions } from "./sessions";

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "abcdef1234567890",
    timestamp: "2026-08-20T14:03:11.000Z",
    cwd: "/srv/projects/api",
    hostname: "workstation-02",
    eventCount: 12,
    promptCount: 3,
    errorCount: 0,
    toolCounts: { Bash: 2 },
    endReason: "ended",
    hasTranscript: false,
    status: "ended",
    ...over,
  };
}

/** Query strings the fake webapi was asked for, newest last. */
const asked: string[] = [];
/** What the next list call returns; a test that cares sets it. */
let listResponse = { sessions: [session()], totalCount: 1 };

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    asked.push(url.search);
    if (url.pathname === "/api/sessions") return Response.json(listResponse);
    return new Response("not found", { status: 404 });
  },
});

const WEBAPI = `http://localhost:${server.port}`;

beforeAll(() => {
  asked.length = 0;
});
afterAll(() => server.stop(true));

/** Run the command with stdout/stderr captured, so assertions can read what it said. */
async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    const code = await runSessions(["--webapi", WEBAPI, ...args]);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** The query string of the most recent request. */
function lastQuery(): URLSearchParams {
  return new URLSearchParams(asked.at(-1) ?? "");
}

describe("sessions --<filter>", () => {
  test("every filter reaches the gateway, under the name the API gives it", async () => {
    const r = await run(
      "--cwd",
      "/srv/projects/api",
      "--model",
      "claude-opus-5[1m]",
      "--hostname",
      "workstation-02",
      "--source",
      "backfill",
      "--from",
      "2026-08-01T00:00:00.000Z",
      "--to",
      "2026-08-31T00:00:00.000Z",
    );
    expect(r.code).toBe(0);

    const q = lastQuery();
    expect(q.get("cwd")).toBe("/srv/projects/api");
    expect(q.get("model")).toBe("claude-opus-5[1m]");
    expect(q.get("hostname")).toBe("workstation-02");
    expect(q.get("source")).toBe("backfill");
    expect(q.get("from")).toBe("2026-08-01T00:00:00.000Z");
    expect(q.get("to")).toBe("2026-08-31T00:00:00.000Z");
  });

  test("an unused filter is left out of the query rather than sent empty", async () => {
    await run("--cwd", "/srv/projects/api");
    const q = lastQuery();
    expect(q.has("model")).toBe(false);
    expect(q.has("source")).toBe(false);
    expect(q.has("from")).toBe(false);
  });

  test("the header says what was filtered, and counts matches rather than the corpus", async () => {
    const r = await run("--source", "backfill");
    expect(r.out).toContain("1 matching");
    expect(r.out).toContain("source=backfill");
  });

  test("with no filter it still says 'total', not 'matching'", async () => {
    const r = await run();
    expect(r.out).toContain("1 total");
    expect(r.out).not.toContain("matching");
  });

  test("no matches is reported as no matches, not as an empty corpus", async () => {
    const previous = listResponse;
    listResponse = { sessions: [], totalCount: 0 };
    try {
      const r = await run("--hostname", "a-host-that-recorded-nothing");
      expect(r.out).toContain("none match");
      expect(r.out).not.toContain("none recorded yet");
    } finally {
      listResponse = previous;
    }
  });

  test("an empty corpus still reads as an empty corpus", async () => {
    const previous = listResponse;
    listResponse = { sessions: [], totalCount: 0 };
    try {
      const r = await run();
      expect(r.out).toContain("none recorded yet");
    } finally {
      listResponse = previous;
    }
  });

  test("a filter alongside a session id is refused, not silently dropped", async () => {
    const before = asked.length;
    const r = await run("abcdef12", "--cwd", "/srv/projects/api");
    expect(r.code).toBe(2);
    expect(r.err).toContain("filter the list");
    // Refused before the request: a detail fetch that ignored the filter would have
    // printed a session the filter excludes.
    expect(asked.length).toBe(before);
  });
});
