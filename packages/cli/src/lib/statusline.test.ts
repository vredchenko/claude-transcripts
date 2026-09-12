/**
 * The statusline's states. The one that matters is the *negative* one: a store that
 * has been refusing writes must not get a confident green dot (plugin.md invariant 2).
 */
import { describe, expect, test } from "bun:test";
import type { StoreHealth, Targets } from "../hook/runtime";
import {
  renderStatusline,
  STALL_AFTER_MS,
  storeState,
  versionLabel,
  whereLabel,
} from "./statusline";

const NOW = 1_700_000_000_000;
/** Pinned, so these assert a format rather than whatever this checkout is stamped as. */
const VERSION = "9.9.9";
const CT = "ct@9.9.9";

/** Every state carries the version, so the tests below always pass one. */
function state(over: Partial<Parameters<typeof renderStatusline>[0]>) {
  return { configured: true, targets: null, counts: null, version: VERSION, ...over };
}

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

/** A direct store plus mirrors, in the order `stores` uses (index 0 is the direct one). */
function stores(direct: Partial<StoreHealth>, ...mirrors: Partial<StoreHealth>[]): StoreHealth[] {
  return [
    { label: "sessions@primary:5984", kind: "direct", lastWriteMs: 0, lastFailureMs: 0, ...direct },
    ...mirrors.map((m, i) => ({
      label: `mirror${i + 1}.example.net`,
      kind: "mirror" as const,
      lastWriteMs: 0,
      lastFailureMs: 0,
      ...m,
    })),
  ];
}

describe("renderStatusline", () => {
  test("no instance configured → off", () => {
    expect(renderStatusline(state({ configured: false }), NOW)).toBe(
      `○ ${CT} off · no instance configured`,
    );
  });

  test("configured but this session has no targets → off, not recording", () => {
    const line = renderStatusline(state({}), NOW);
    expect(line.startsWith(`○ ${CT} off`)).toBe(true);
  });

  test("a recent successful write → recording, with counts and the store", () => {
    const line = renderStatusline(
      state({ targets: targets({ lastWriteMs: NOW - 2000 }), counts }),
      NOW,
    );
    expect(line).toBe(
      `● ${CT} rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652`,
    );
  });

  test("no write yet → ready, not recording", () => {
    const line = renderStatusline(state({ targets: targets(), counts }), NOW);
    expect(line.startsWith(`◌ ${CT} ready`)).toBe(true);
    expect(line).toContain("no write yet");
  });

  test("failures after the last success, past the stall window → stalled", () => {
    const t = targets({
      lastWriteMs: NOW - STALL_AFTER_MS - 1000,
      lastFailureMs: NOW - 500,
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled`)).toBe(true);
    expect(line).toContain("last write 1m ago");
  });

  test("a failure within the stall window still shows recording", () => {
    const t = targets({ lastWriteMs: NOW - 10_000, lastFailureMs: NOW - 500 });
    expect(renderStatusline(state({ targets: t, counts }), NOW).startsWith(`● ${CT} rec`)).toBe(
      true,
    );
  });

  test("a stale failure before a fresh success is forgotten", () => {
    const t = targets({ lastWriteMs: NOW - 1000, lastFailureMs: NOW - 5000 });
    expect(renderStatusline(state({ targets: t, counts }), NOW).startsWith(`● ${CT} rec`)).toBe(
      true,
    );
  });

  test("the version is on every state, including the ones that report nothing", () => {
    // The states worth knowing the version in are exactly the broken ones: "which
    // binary is this?" is the first question when the line says off or stalled.
    const stalled = targets({ lastWriteMs: NOW - STALL_AFTER_MS - 1000, lastFailureMs: NOW });
    for (const line of [
      renderStatusline(state({ configured: false }), NOW),
      renderStatusline(state({}), NOW),
      renderStatusline(state({ targets: targets(), counts }), NOW),
      renderStatusline(state({ targets: stalled, counts }), NOW),
      renderStatusline(state({ targets: targets({ lastWriteMs: NOW }), counts }), NOW),
    ]) {
      expect(line).toContain(CT);
    }
  });
});

describe("versionLabel", () => {
  test("a release is shown as its number", () => {
    expect(versionLabel("0.2.0")).toBe("ct@0.2.0");
  });

  test("a checkout is 'dev', not thirteen characters of 0.0.0-dev", () => {
    expect(versionLabel("0.0.0-dev")).toBe("ct@dev");
  });

  test("with nothing passed it reports this binary, and is never empty", () => {
    expect(versionLabel()).toMatch(/^ct@.+/);
  });
});

test("whereLabel strips scheme and path", () => {
  expect(whereLabel(targets({ couchUrl: "https://couch.example.net/prefix" }))).toBe(
    "claude-transcripts-sessions@couch.example.net",
  );
});

describe("storeState", () => {
  test("a store that has never been written to, with no failure, is idle", () => {
    expect(storeState({ lastWriteMs: 0, lastFailureMs: 0 }, NOW)).toBe("idle");
  });

  test("a rejection with no success ever is failing, not idle", () => {
    expect(storeState({ lastWriteMs: 0, lastFailureMs: NOW - 500 }, NOW)).toBe("failing");
  });

  test("a rejection inside the stall window does not unseat a recent success", () => {
    expect(storeState({ lastWriteMs: NOW - 10_000, lastFailureMs: NOW - 500 }, NOW)).toBe(
      "healthy",
    );
  });

  test("a rejection newer than a success that has aged out is failing", () => {
    const s = { lastWriteMs: NOW - STALL_AFTER_MS - 1000, lastFailureMs: NOW - 500 };
    expect(storeState(s, NOW)).toBe("failing");
  });
});

describe("renderStatusline, per-store health", () => {
  test("a healthy direct store reads exactly as it did before per-store health", () => {
    const t = targets({
      lastWriteMs: NOW - 2000,
      stores: stores({
        label: "claude-transcripts-sessions@127.0.0.1:7652",
        lastWriteMs: NOW - 2000,
      }),
    });
    expect(renderStatusline(state({ targets: t, counts }), NOW)).toBe(
      `● ${CT} rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652`,
    );
  });

  // The bug this whole change exists for: the primary has accepted nothing for weeks,
  // the mirror holds every byte, and the old renderer had to lie in one direction or
  // the other — a permanent red, or a green dot naming the dead host.
  test("a dead primary with a live mirror records, and names the mirror", () => {
    const t = targets({
      lastWriteMs: NOW - 2000,
      stores: stores(
        { lastWriteMs: NOW - STALL_AFTER_MS - 5000, lastFailureMs: NOW - 500 },
        { label: "logs.example.net", lastWriteMs: NOW - 2000 },
      ),
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW);
    expect(line).toBe(`● ${CT} rec (mirror) · 128 ev · 6 tools · 2s ago → logs.example.net`);
    expect(line).not.toContain("primary:5984");
  });

  test("more than one healthy mirror is counted, not listed", () => {
    const t = targets({
      stores: stores(
        { lastFailureMs: NOW - 500 },
        { label: "a.example.net", lastWriteMs: NOW - 2000 },
        { label: "b.example.net", lastWriteMs: NOW - 3000 },
      ),
    });
    expect(renderStatusline(state({ targets: t, counts }), NOW)).toBe(
      `● ${CT} rec (mirror) · 128 ev · 6 tools · 2s ago → a.example.net +1`,
    );
  });

  test("every store failing is stalled, and reports the newest success across them", () => {
    const t = targets({
      stores: stores(
        { lastWriteMs: NOW - STALL_AFTER_MS - 600_000, lastFailureMs: NOW - 500 },
        { lastWriteMs: NOW - STALL_AFTER_MS - 60_000, lastFailureMs: NOW - 500 },
      ),
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled`)).toBe(true);
    expect(line).toContain("last write 2m ago");
  });

  test("stores present but nothing tried yet is ready, not stalled", () => {
    const t = targets({ stores: stores({}, {}) });
    expect(renderStatusline(state({ targets: t, counts }), NOW).startsWith(`◌ ${CT} ready`)).toBe(
      true,
    );
  });

  // The targets file lives in /tmp per session, so a session that began under an older
  // binary and continued past an upgrade hands the renderer a file with no `stores`.
  test("a targets file from an older binary still renders from the flat pair", () => {
    const t = targets({ lastWriteMs: NOW - 2000 });
    expect(t.stores).toBeUndefined();
    expect(renderStatusline(state({ targets: t, counts }), NOW)).toBe(
      `● ${CT} rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652`,
    );
  });

  test("an empty stores array is treated as absent, not as no stores at all", () => {
    const t = targets({ lastWriteMs: NOW - 2000, stores: [] });
    expect(renderStatusline(state({ targets: t, counts }), NOW).startsWith(`● ${CT} rec`)).toBe(
      true,
    );
  });
});
