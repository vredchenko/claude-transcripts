/**
 * The session-start banner and the targets it is built from. The credential check is
 * the one that must never regress: the targets file is read by a renderer whose output
 * lands in a terminal, and the banner lands in the transcript.
 */
import { describe, expect, test } from "bun:test";
import { recordingBanner, sessionStartEnvelope } from "./announce";
import { type HookConfig, resolveTargets } from "./runtime";

const config: HookConfig = {
  couch: {
    url: "http://admin:s3cret@127.0.0.1:7652",
    databases: { sessions: "claude-transcripts-sessions", logs: "claude-transcripts-logs" },
    auth: "admin:s3cret",
  },
  blob: {
    endpoint: "http://127.0.0.1:7654",
    region: "garage",
    accessKey: "GK1",
    secretKey: "shh",
    buckets: { sessions: "claude-transcripts-sessions" },
  },
  mirrors: [{ url: "http://user:pw@mirror.example.net:7650" }],
  features: { midFlightChunking: true, meilisearch: false },
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
};

describe("resolveTargets", () => {
  test("carries no credentials", () => {
    const t = resolveTargets(config, "http://127.0.0.1:7650");
    const json = JSON.stringify(t);
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("shh");
    expect(json).not.toContain("GK1");
    expect(json).not.toContain("user:pw");
    expect(t.couchUrl).toBe("http://127.0.0.1:7652");
    expect(t.mirrors).toEqual(["http://mirror.example.net:7650"]);
  });

  test("no S3 access key → no bucket claimed", () => {
    const t = resolveTargets({ ...config, blob: { ...config.blob!, accessKey: undefined } });
    expect(t.bucket).toBeUndefined();
  });
});

describe("recordingBanner", () => {
  // A bare count let the banner headline a store that was dead while a mirror held
  // everything; the reader could not tell where their history was going without
  // opening the config. Naming them costs one line and answers it.
  test("names mirror hosts rather than counting them, without credentials", () => {
    const t = resolveTargets(
      {
        ...config,
        mirrors: [
          { url: "https://user:pw@a.example.net" },
          { url: "https://b.example.net:7650/base" },
        ],
      },
      "http://127.0.0.1:7650",
    );
    const banner = recordingBanner(t, "abc123");
    expect(banner).toContain("mirrors: a.example.net, b.example.net:7650");
    expect(banner).not.toContain("mirror(s)");
    expect(banner).not.toContain("user:pw");
  });
});

test("the envelope carries the primer as SessionStart additionalContext, and is null when empty", () => {
  expect(sessionStartEnvelope({})).toBeNull();
  expect(sessionStartEnvelope({ systemMessage: "hi", additionalContext: "ctx" })).toEqual({
    systemMessage: "hi",
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
  });
});
