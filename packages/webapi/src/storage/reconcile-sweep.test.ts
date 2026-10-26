import { describe, expect, test } from "bun:test";
import type { AppContext } from "../context";
import { type CliRunner, selfUrl, staleSessionIds, startReconcileSweep } from "./reconcile-sweep";
import type { SessionIndexRow } from "./session-index";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function row(key: string, last: string, ended = false): SessionIndexRow {
  return {
    key,
    value: {
      ended: ended ? 1 : 0,
      events: 2,
      prompts: 1,
      errors: 0,
      started: 1,
      tools: {},
      first: last,
      last,
      summary: ended ? { event_count: 2 } : null,
    } as any,
  };
}

const ROWS = [
  row("ended", ago(100), true),
  row("running", ago(1)),
  row("old", ago(200)),
  row("older", ago(300)),
];

describe("staleSessionIds", () => {
  const opts = { nowMs: NOW, windowMs: 24 * 3600_000, limit: 10, skip: new Set<string>() };

  test("picks what reads as incomplete, oldest first", () => {
    expect(staleSessionIds(ROWS, opts)).toEqual(["older", "old"]);
  });

  test("honours the batch size and the skip set", () => {
    expect(staleSessionIds(ROWS, { ...opts, limit: 1 })).toEqual(["older"]);
    expect(staleSessionIds(ROWS, { ...opts, skip: new Set(["older"]) })).toEqual(["old"]);
  });
});

test("selfUrl dials the loopback for a wildcard bind", () => {
  const cfg = (host: string) => ({ webapi: { host, port: 7650 } }) as any;
  expect(selfUrl(cfg("0.0.0.0"))).toBe("http://127.0.0.1:7650");
  expect(selfUrl(cfg("10.1.2.3"))).toBe("http://10.1.2.3:7650");
  expect(selfUrl(cfg("::"))).toBe("http://127.0.0.1:7650");
});

function ctx(reconcile: object = {}, triggers: object = { cli: "reconcile", follower: true }) {
  return {
    blueprint: { actions: [{ key: "reconcile-session", implemented: true, triggers }] },
    config: {
      webapi: { host: "127.0.0.1", port: 7650, cliBin: "/usr/local/bin/claude-transcripts" },
      system: { sessions: { reconcile } },
    },
    sessionIndex: { ready: true, rows: () => ROWS },
  } as unknown as AppContext;
}

describe("startReconcileSweep", () => {
  test("runs the action's CLI command against this webapi with the stale ids", async () => {
    const calls: string[][] = [];
    const run: CliRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: JSON.stringify({ outcomes: [] }) };
    };
    const sweep = startReconcileSweep(ctx(), run, () => NOW)!;
    await sweep.sweep();
    sweep.stop();
    expect(calls).toEqual([
      [
        "/usr/local/bin/claude-transcripts",
        "reconcile",
        "older",
        "old",
        "--webapi",
        "http://127.0.0.1:7650",
        "--json",
      ],
    ]);
  });

  test("a session the CLI failed on is not retried", async () => {
    const calls: string[][] = [];
    const run: CliRunner = async (argv) => {
      calls.push(argv);
      const outcomes = [
        { sessionId: "older", result: "failed" },
        { sessionId: "old", result: "reconciled" },
      ];
      return { code: 1, stdout: JSON.stringify({ outcomes }) };
    };
    const sweep = startReconcileSweep(ctx(), run, () => NOW)!;
    await sweep.sweep();
    await sweep.sweep();
    sweep.stop();
    expect(calls[1]).not.toContain("older");
  });

  test("a run that reports nothing holds its whole batch back", async () => {
    let calls = 0;
    const run: CliRunner = async () => {
      calls++;
      return { code: null, stdout: "" };
    };
    const sweep = startReconcileSweep(ctx(), run, () => NOW)!;
    await sweep.sweep();
    await sweep.sweep();
    sweep.stop();
    expect(calls).toBe(1);
  });

  test("off when config switches it off, or the blueprint gives it no follower trigger", () => {
    expect(startReconcileSweep(ctx({ follower: false }))).toBeNull();
    expect(startReconcileSweep(ctx({}, { cli: "reconcile" }))).toBeNull();
  });
});
