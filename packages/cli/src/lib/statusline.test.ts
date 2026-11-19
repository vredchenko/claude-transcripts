/**
 * The statusline's states. The one that matters is the *negative* one: a store that
 * has been refusing writes must not get a confident green dot (plugin.md invariant 2).
 */
import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { StoreHealth, Targets } from "../hook/runtime";
import {
  HOOK_SILENT_AFTER_MS,
  hookSilent,
  RECOVER_HINT,
  renderStatusline,
  shortWhere,
  storeState,
  transcriptMtimeMs,
  versionLabel,
} from "./statusline";

const NOW = 1_700_000_000_000;
/**
 * Pinned, so these assert a format rather than whatever this checkout is stamped as —
 * and pinned to the shape a **release actually carries**, `v` included. The first cut
 * of this suite used "9.9.9", which no build ever produces: `APP_VERSION` is spelled
 * as the git tag is. The tests passed, the docs said `ct@0.2.0`, and the released binary
 * rendered `ct@v0.3.0` — an invented fixture agreeing with nothing.
 */
const VERSION = "v9.9.9";
const CT = "ct@v9.9.9";

/** Every state carries the version, so the tests below always pass one. */
function state(over: Partial<Parameters<typeof renderStatusline>[0]>) {
  return { configured: true, targets: null, counts: null, version: VERSION, ...over };
}

function targets(over: Partial<Targets> = {}): Targets {
  return {
    webapiUrl: "http://127.0.0.1:7650",
    features: [],
    mirrors: [],
    lastWriteMs: 0,
    lastFailureMs: 0,
    ...over,
  };
}

/** Long enough ago that nothing about the line could be "recent". */
const A_MINUTE = 60_000;

const counts = { events: 128, prompts: 4, errors: 0, tools: { Bash: 4, Read: 2 } };

/** The instance's webapi plus mirrors, in the order `stores` uses (index 0 is the instance). */
function stores(direct: Partial<StoreHealth>, ...mirrors: Partial<StoreHealth>[]): StoreHealth[] {
  return [
    { label: "primary:7650", kind: "webapi", lastWriteMs: 0, lastFailureMs: 0, ...direct },
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
  test("configured but this session has no targets → off, not recording", () => {
    const line = renderStatusline(state({}), NOW);
    expect(line.startsWith(`○ ${CT} off`)).toBe(true);
  });

  test("a recent successful write → recording, with counts and the webapi", () => {
    const line = renderStatusline(
      state({ targets: targets({ lastWriteMs: NOW - 2000 }), counts }),
      NOW,
    );
    expect(line).toBe(`● ${CT} rec · 128 ev · 6 tools · 2s ago → 127.0.0.1:7650`);
  });

  test("a targets file from before #288 still names the CouchDB it wrote to", () => {
    const t = targets({
      webapiUrl: undefined,
      couchUrl: "http://127.0.0.1:7652",
      sessionsDb: "claude-transcripts-sessions",
      lastWriteMs: NOW - 2000,
    });
    expect(renderStatusline(state({ targets: t, counts }), NOW)).toBe(
      `● ${CT} rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652`,
    );
  });

  test("no write yet → ready, not recording", () => {
    const line = renderStatusline(state({ targets: targets(), counts }), NOW);
    expect(line.startsWith(`◌ ${CT} ready`)).toBe(true);
    expect(line).toContain("no write yet");
  });

  test("a failure after the last success → stalled, with the recovery command", () => {
    const t = targets({
      lastWriteMs: NOW - A_MINUTE - 1000,
      lastFailureMs: NOW - 500,
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled`)).toBe(true);
    expect(line).toContain("last write 1m ago");
    expect(line).toContain(RECOVER_HINT);
  });

  test("the version is on every state, including the ones that report nothing", () => {
    // The states worth knowing the version in are exactly the broken ones: "which
    // binary is this?" is the first question when the line says off or stalled.
    const stalled = targets({ lastWriteMs: NOW - A_MINUTE - 1000, lastFailureMs: NOW });
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
  test("a release is shown as its tag, prefix and all", () => {
    // What a release binary is actually stamped with — see the note on VERSION.
    expect(versionLabel("v0.2.0")).toBe("ct@v0.2.0");
  });
});

describe("storeState", () => {
  test("a store that has never been written to, with no failure, is idle", () => {
    expect(storeState({ lastWriteMs: 0, lastFailureMs: 0 }, NOW)).toBe("idle");
  });

  test("a rejection with no success ever is failing, not idle", () => {
    expect(storeState({ lastWriteMs: 0, lastFailureMs: NOW - 500 }, NOW)).toBe("failing");
  });

  test("the FIRST rejection after a success is failing — no grace window (#288)", () => {
    // Nothing buffers a failed write, so every one is a gap only backfill fills; a
    // window that hid it for a minute hid exactly the writes that were lost.
    expect(storeState({ lastWriteMs: NOW - 10_000, lastFailureMs: NOW - 500 }, NOW)).toBe(
      "failing",
    );
  });

  test("a failure followed by a success is forgotten", () => {
    expect(storeState({ lastWriteMs: NOW - 1000, lastFailureMs: NOW - 5000 }, NOW)).toBe("healthy");
  });
});

describe("renderStatusline, per-store health", () => {
  // The bug this whole change exists for: the primary has accepted nothing for weeks,
  // the mirror holds every byte, and the old renderer had to lie in one direction or
  // the other — a permanent red, or a green dot naming the dead host.
  test("a dead instance with a live mirror records, names the mirror, and asks for backfill", () => {
    const t = targets({
      lastWriteMs: NOW - 2000,
      stores: stores(
        { lastWriteMs: NOW - A_MINUTE - 5000, lastFailureMs: NOW - 500 },
        { label: "logs.example.net", lastWriteMs: NOW - 2000 },
      ),
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW);
    expect(line).toBe(
      `● ${CT} rec (mirror) · 128 ev · 6 tools · 2s ago · ${RECOVER_HINT} → logs.example.net`,
    );
    expect(line).not.toContain("primary:7650");
  });

  test("every store failing is stalled, and reports the newest success across them", () => {
    const t = targets({
      stores: stores(
        { lastWriteMs: NOW - A_MINUTE - 600_000, lastFailureMs: NOW - 500 },
        { lastWriteMs: NOW - A_MINUTE - 60_000, lastFailureMs: NOW - 500 },
      ),
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled`)).toBe(true);
    expect(line).toContain("last write 2m ago");
  });

  test("a failing instance names why, and the line shows the fix", () => {
    const t = targets({
      stores: stores({
        lastWriteMs: NOW - 30_000,
        lastFailureMs: NOW - 500,
        lastError: "HTTP 503",
      }),
    });
    expect(renderStatusline(state({ targets: t, counts }), NOW)).toBe(
      `◐ ${CT} stalled · HTTP 503 · 128 ev · 6 tools · last write 30s ago · ${RECOVER_HINT} → primary:7650`,
    );
  });

  test("the fix is dropped before the facts when the terminal is narrow", () => {
    const t = targets({
      stores: stores({ lastWriteMs: NOW - 30_000, lastFailureMs: NOW - 500, lastError: "timeout" }),
    });
    const line = renderStatusline(state({ targets: t, counts }), NOW, { columns: 70 });
    expect(line).not.toContain(RECOVER_HINT);
    expect(line).toContain("timeout");
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
    expect(renderStatusline(state({ targets: t, counts }), NOW).startsWith(`● ${CT} rec`)).toBe(
      true,
    );
  });

  test("an empty stores array is treated as absent, not as no stores at all", () => {
    const t = targets({ lastWriteMs: NOW - 2000, stores: [] });
    expect(renderStatusline(state({ targets: t, counts }), NOW).startsWith(`● ${CT} rec`)).toBe(
      true,
    );
  });
});

// Issue #125: a hook that stops being invoked records no failure; the transcript's mtime
// is what tells it apart from an idle session.
describe("renderStatusline, hook silent", () => {
  const oldWrite = NOW - HOOK_SILENT_AFTER_MS - 120_000; // 7m ago, no failure since

  test("old write, no failure, transcript modified since → stalled, hook silent", () => {
    const t = targets({ lastWriteMs: oldWrite });
    const line = renderStatusline(
      state({ targets: t, counts, transcriptMtimeMs: NOW - 1000 }),
      NOW,
    );
    expect(line.startsWith(`◐ ${CT} stalled · hook silent`)).toBe(true);
    expect(line).toContain("last write 7m ago");
  });

  test("old write, transcript just as old → an idle session, still rec", () => {
    const t = targets({ lastWriteMs: oldWrite });
    const line = renderStatusline(
      state({ targets: t, counts, transcriptMtimeMs: oldWrite - 50 }),
      NOW,
    );
    expect(line.startsWith(`● ${CT} rec`)).toBe(true);
  });

  test("no transcript_path → the old behaviour, rec", () => {
    const t = targets({ lastWriteMs: oldWrite });
    for (const transcriptMtimeMs of [undefined, null]) {
      const line = renderStatusline(state({ targets: t, counts, transcriptMtimeMs }), NOW);
      expect(line.startsWith(`● ${CT} rec`)).toBe(true);
    }
  });

  test("a long tool-less turn appending within the window is not a false alarm", () => {
    const t = targets({ lastWriteMs: NOW - 4 * 60_000 });
    const line = renderStatusline(state({ targets: t, counts, transcriptMtimeMs: NOW }), NOW);
    expect(line.startsWith(`● ${CT} rec`)).toBe(true);
  });

  test("failing writes keep the plain stalled line: the hook is running", () => {
    const t = targets({ lastWriteMs: oldWrite, lastFailureMs: NOW - 500 });
    const line = renderStatusline(state({ targets: t, counts, transcriptMtimeMs: NOW }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled · 128 ev`)).toBe(true);
  });

  test("a hook that went silent while failing says hook silent, not just stalled", () => {
    const t = targets({ lastWriteMs: oldWrite, lastFailureMs: oldWrite + 1000 });
    const line = renderStatusline(state({ targets: t, counts, transcriptMtimeMs: NOW }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled · hook silent · 128 ev`)).toBe(true);
  });

  test("with per-store health, a healthy-looking store does not hide a silent hook", () => {
    const t = targets({
      lastWriteMs: oldWrite,
      stores: stores(
        { lastWriteMs: oldWrite - 60_000 },
        { label: "logs.example.net", lastWriteMs: oldWrite },
      ),
    });
    const line = renderStatusline(state({ targets: t, counts, transcriptMtimeMs: NOW }), NOW);
    expect(line.startsWith(`◐ ${CT} stalled · hook silent`)).toBe(true);
  });
});

describe("hookSilent", () => {
  test("no baseline (the hook never attempted anything) is not silent — that is ready", () => {
    expect(hookSilent(0, NOW)).toBe(false);
  });
});

describe("transcriptMtimeMs", () => {
  test("missing, empty or non-string paths are null, never a throw", () => {
    expect(transcriptMtimeMs("/nonexistent/ct-statusline/t.jsonl")).toBeNull();
    expect(transcriptMtimeMs(undefined)).toBeNull();
    expect(transcriptMtimeMs("")).toBeNull();
    expect(transcriptMtimeMs(42)).toBeNull();
  });
});

/** The line with every escape sequence removed: what the terminal actually shows. */
const visible = stripVTControlCharacters;

describe("renderStatusline, drawing", () => {
  const rec = state({ targets: targets({ lastWriteMs: NOW - 2000 }), counts });
  const plain = renderStatusline(rec, NOW);

  test("colour changes the look, never the text", () => {
    const line = renderStatusline(rec, NOW, { color: true });
    expect(line).toContain("\x1b[32m●");
    expect(visible(line)).toBe(plain);
  });

  test("each state gets its own colour", () => {
    const stalled = targets({ lastWriteMs: NOW - 10 * 60_000, lastFailureMs: NOW - 1000 });
    expect(renderStatusline(state({ targets: stalled, counts }), NOW, { color: true })).toContain(
      "\x1b[33m◐",
    );
    expect(renderStatusline(state({ targets: targets(), counts }), NOW, { color: true })).toContain(
      "\x1b[36m◌",
    );
  });

  test("a link wraps the store label, and only that", () => {
    const url = "http://127.0.0.1:7650/app/sessions/abc";
    const line = renderStatusline(rec, NOW, { link: url });
    expect(line).toContain(`\x1b]8;;${url}\x1b\\127.0.0.1:7650\x1b]8;;\x1b\\`);
    expect(visible(line)).toBe(plain);
  });

  test("a narrow terminal drops detail, least useful first, never the state or version", () => {
    const named = state({
      targets: targets({
        webapiUrl: "https://transcripts.example.net:7650",
        lastWriteMs: NOW - 2000,
      }),
      counts,
    });
    const at = (columns: number) => renderStatusline(named, NOW, { columns });
    expect(at(200)).toBe(`● ${CT} rec · 128 ev · 6 tools · 2s ago → transcripts.example.net:7650`);
    expect(at(70)).toBe(`● ${CT} rec · 128 ev · 2s ago → transcripts.example.net:7650`);
    expect(at(50)).toBe(`● ${CT} rec · 128 ev · 2s ago → transcripts`);
    expect(at(40)).toBe(`● ${CT} rec · 2s ago → transcripts`);
    expect(at(30)).toBe(`● ${CT} rec → transcripts`);
    expect(at(10)).toBe(`● ${CT} rec`);
  });

  test("width is measured on what shows, not on the escapes", () => {
    const line = renderStatusline(rec, NOW, { color: true, link: "http://x/y", columns: 80 });
    expect(visible(line)).toBe(renderStatusline(rec, NOW, { columns: 80 }));
  });
});

describe("shortWhere", () => {
  test("keeps a name that still says which store it is", () => {
    expect(shortWhere("sessions@couch.example.net:5984")).toBe("sessions");
    expect(shortWhere("backup.example.net:7650")).toBe("backup");
    // An IP's first octet names nothing, so it stays whole, minus the port.
    expect(shortWhere("10.0.0.5:7650")).toBe("10.0.0.5");
    expect(shortWhere("[::1]:7650")).toBe("[::1]");
  });
});
