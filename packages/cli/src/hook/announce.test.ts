/**
 * The session-start banner and the targets it is built from. The credential check is
 * the one that must never regress: the targets file is read by a renderer whose output
 * lands in a terminal, and the banner lands in the transcript.
 */
import { describe, expect, test } from "bun:test";
import {
  NOT_RECORDING_BANNER,
  notRecordingBanner,
  recordingBanner,
  sessionStartEnvelope,
  unreachableBanner,
} from "./announce";
import { type HookConfig, resolveTargets } from "./runtime";

const config: HookConfig = {
  webapi: { url: "http://admin:s3cret@127.0.0.1:7650", auth: "admin:s3cret" },
  mirrors: [{ url: "http://user:pw@mirror.example.net:7650" }],
  features: { midFlightChunking: true, meilisearch: false },
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
};

describe("resolveTargets", () => {
  test("carries no credentials", () => {
    const t = resolveTargets(config);
    const json = JSON.stringify(t);
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("user:pw");
    expect(t.webapiUrl).toBe("http://127.0.0.1:7650");
    expect(t.mirrors).toEqual(["http://mirror.example.net:7650"]);
  });
});

describe("recordingBanner", () => {
  // A bare count let the banner headline a target that was dead while a mirror held
  // everything; the reader could not tell where their history was going without
  // opening the config. Naming them costs one line and answers it.
  test("names mirror hosts rather than counting them, without credentials", () => {
    const t = resolveTargets({
      ...config,
      mirrors: [
        { url: "https://user:pw@a.example.net" },
        { url: "https://b.example.net:7650/base" },
      ],
    });
    const banner = recordingBanner(t, "abc123");
    expect(banner).toContain("mirrors: a.example.net, b.example.net:7650");
    expect(banner).not.toContain("mirror(s)");
    expect(banner).not.toContain("user:pw");
  });

  test("names the webapi it writes through, link on a line of its own", () => {
    const t = resolveTargets(config);
    expect(recordingBanner(t, "abc123").split("\n")).toEqual([
      "● Claude Transcripts recording → 127.0.0.1:7650 (+ mirrors: mirror.example.net:7650)",
      "  http://127.0.0.1:7650/app/sessions/abc123",
    ]);
  });
});

describe("not recording, said out loud", () => {
  test("an unreachable webapi names the target, the reason and the recovery", () => {
    const banner = unreachableBanner(resolveTargets(config), "timeout");
    expect(banner).toContain("NOT recording");
    expect(banner).toContain("127.0.0.1:7650: timeout");
    expect(banner).toContain("claude-transcripts backfill");
    expect(banner).not.toContain("s3cret");
  });

  test("a config problem is given verbatim; no problem given means not installed", () => {
    expect(notRecordingBanner("no webapi configured")).toBe(
      "○ Claude Transcripts not recording — no webapi configured.",
    );
    expect(NOT_RECORDING_BANNER).toContain("claude-transcripts install");
  });
});

test("the envelope carries the primer as SessionStart additionalContext, and is null when empty", () => {
  expect(sessionStartEnvelope({})).toBeNull();
  expect(sessionStartEnvelope({ systemMessage: "hi", additionalContext: "ctx" })).toEqual({
    systemMessage: "hi",
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
  });
});
