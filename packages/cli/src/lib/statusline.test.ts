/**
 * The statusline's states. The one that matters is the *negative* one: a store that
 * has been refusing writes must not get a confident green dot (plugin.md invariant 2).
 */
import { describe, expect, test } from "bun:test";
import type { Targets } from "../hook/runtime";
import { renderStatusline, STALL_AFTER_MS, whereLabel } from "./statusline";

const NOW = 1_700_000_000_000;

function targets(over: Partial<Targets> = {}): Targets {
  return {
    couchUrl: "http://127.0.0.1:7652",
    sessionsDb: "claude-transcripts-sessions",
    bucket: "claude-transcripts-sessions",
    webapiUrl: "http://127.0.0.1:7650",
    features: [],
    mirrors: [],
    lastWriteMs: 0,
    lastFailureMs: 0,
    ...over,
  };
}

const counts = { events: 128, prompts: 4, errors: 0, tools: { Bash: 4, Read: 2 } };

describe("renderStatusline", () => {
  test("no instance configured → off", () => {
    expect(renderStatusline({ configured: false, targets: null, counts: null }, NOW)).toBe(
      "○ ct off · no instance configured",
    );
  });

  test("configured but this session has no targets → off, not recording", () => {
    const line = renderStatusline({ configured: true, targets: null, counts: null }, NOW);
    expect(line.startsWith("○ ct off")).toBe(true);
  });

  test("a recent successful write → recording, with counts and the store", () => {
    const line = renderStatusline(
      { configured: true, targets: targets({ lastWriteMs: NOW - 2000 }), counts },
      NOW,
    );
    expect(line).toBe(
      "● ct rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652",
    );
  });

  test("no write yet → ready, not recording", () => {
    const line = renderStatusline({ configured: true, targets: targets(), counts }, NOW);
    expect(line.startsWith("◌ ct ready")).toBe(true);
    expect(line).toContain("no write yet");
  });

  test("failures after the last success, past the stall window → stalled", () => {
    const t = targets({
      lastWriteMs: NOW - STALL_AFTER_MS - 1000,
      lastFailureMs: NOW - 500,
    });
    const line = renderStatusline({ configured: true, targets: t, counts }, NOW);
    expect(line.startsWith("◐ ct stalled")).toBe(true);
    expect(line).toContain("last write 1m ago");
  });

  test("a failure within the stall window still shows recording", () => {
    const t = targets({ lastWriteMs: NOW - 10_000, lastFailureMs: NOW - 500 });
    expect(
      renderStatusline({ configured: true, targets: t, counts }, NOW).startsWith("● ct rec"),
    ).toBe(true);
  });

  test("a stale failure before a fresh success is forgotten", () => {
    const t = targets({ lastWriteMs: NOW - 1000, lastFailureMs: NOW - 5000 });
    expect(
      renderStatusline({ configured: true, targets: t, counts }, NOW).startsWith("● ct rec"),
    ).toBe(true);
  });
});

test("whereLabel strips scheme and path", () => {
  expect(whereLabel(targets({ couchUrl: "https://couch.example.net/prefix" }))).toBe(
    "claude-transcripts-sessions@couch.example.net",
  );
});
