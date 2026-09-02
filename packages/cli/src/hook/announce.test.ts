/**
 * The session-start banner and the targets it is built from. The credential check is
 * the one that must never regress: the targets file is read by a renderer whose output
 * lands in a terminal, and the banner lands in the transcript.
 */
import { describe, expect, test } from "bun:test";
import { NOT_RECORDING_BANNER, recordingBanner, sessionStartEnvelope } from "./announce";
import { type HookConfig, redactUrl, resolveTargets } from "./runtime";

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

  test("lists only the features that are on, and starts with no write", () => {
    const t = resolveTargets(config);
    expect(t.features).toEqual(["midFlightChunking"]);
    expect(t.lastWriteMs).toBe(0);
    expect(t.bucket).toBe("claude-transcripts-sessions");
  });

  test("no S3 access key → no bucket claimed", () => {
    const t = resolveTargets({ ...config, blob: { ...config.blob!, accessKey: undefined } });
    expect(t.bucket).toBeUndefined();
  });
});

describe("recordingBanner", () => {
  test("names every destination and links the session", () => {
    const t = resolveTargets(config, "http://127.0.0.1:7650");
    expect(recordingBanner(t, "abc123")).toBe(
      "Claude Transcripts — recording to couchdb://127.0.0.1:7652/claude-transcripts-sessions" +
        " + s3://claude-transcripts-sessions + mirrors: mirror.example.net:7650" +
        " · http://127.0.0.1:7650/app/sessions/abc123",
    );
  });

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

  test("without a webapi there is no link", () => {
    const t = resolveTargets({ ...config, blob: undefined, mirrors: [] });
    expect(recordingBanner(t, "abc123")).toBe(
      "Claude Transcripts — recording to couchdb://127.0.0.1:7652/claude-transcripts-sessions",
    );
  });
});

test("the not-recording banner says how to fix it", () => {
  expect(NOT_RECORDING_BANNER).toContain("claude-transcripts install");
  expect(sessionStartEnvelope({ systemMessage: NOT_RECORDING_BANNER })).toEqual({
    systemMessage: NOT_RECORDING_BANNER,
  });
});

test("the envelope carries the primer as SessionStart additionalContext, and is null when empty", () => {
  expect(sessionStartEnvelope({})).toBeNull();
  expect(sessionStartEnvelope({ systemMessage: "hi", additionalContext: "ctx" })).toEqual({
    systemMessage: "hi",
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
  });
});

test("redactUrl leaves a non-URL alone", () => {
  expect(redactUrl("not a url")).toBe("not a url");
});
