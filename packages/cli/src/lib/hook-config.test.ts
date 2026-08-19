/**
 * The hook's runtime config file.
 *
 * Everything in it is a projection of `config/` + `.env` and so is safe to rewrite —
 * except `mirrors`, which is the machine's own and exists nowhere else. These pin that
 * a rewrite keeps it, because losing it stops mirroring silently: the hook swallows
 * every failure by design, so nothing would report the loss.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePreserved, writeHookConfig } from "./hook-config";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ct-hook-config-"));
  path = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MIRRORS = [{ url: "https://logs.example.com", timeoutMs: 2000 }];

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("writeHookConfig", () => {
  test("carries mirrors across a regeneration that knows nothing about them", () => {
    writeFileSync(path, JSON.stringify({ couch: { url: "http://old" }, mirrors: MIRRORS }));

    // What `setup` / `install` rebuild from config + env: no mirrors key at all.
    writeHookConfig(path, { couch: { url: "http://new" }, features: { s3Blobs: true } });

    const out = read();
    expect(out.mirrors).toEqual(MIRRORS);
    expect((out.couch as { url: string }).url).toBe("http://new");
  });

  test("writes a config with no mirrors when the machine never had any", () => {
    writeHookConfig(path, { couch: { url: "http://new" } });
    expect(read().mirrors).toBeUndefined();
  });

  test("an explicit value wins, so a caller can still set or clear mirrors", () => {
    writeFileSync(path, JSON.stringify({ mirrors: MIRRORS }));
    writeHookConfig(path, { couch: { url: "http://new" }, mirrors: [] });
    expect(read().mirrors).toEqual([]);
  });

  test("an unparseable existing file does not block a rewrite", () => {
    writeFileSync(path, "{ not json");
    writeHookConfig(path, { couch: { url: "http://new" } });
    expect((read().couch as { url: string }).url).toBe("http://new");
  });

  test("stays 0600 — it holds store credentials", () => {
    writeHookConfig(path, { couch: { url: "http://new" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("mergePreserved", () => {
  test("only preserved keys survive; the rest of the old file is discarded", () => {
    const merged = mergePreserved(
      { couch: { url: "new" } },
      { couch: { url: "old" }, features: { gone: true }, mirrors: MIRRORS },
    );
    expect(merged).toEqual({ couch: { url: "new" }, mirrors: MIRRORS });
  });
});
