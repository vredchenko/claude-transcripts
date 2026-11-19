/**
 * Loading a hand-written hook config.
 *
 * The lesson from the incident behind this: a config that parses is not a config that
 * works. It threw on first dereference, inside a handler, where the error is caught —
 * so the chunk flush never ran and nothing anywhere said so.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HookConfig, hookConfigProblem, loadHookConfig, normalizeHookConfig } from "./runtime";

function writeConfig(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "ct-cfg-")), "config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const MINIMAL = {
  webapi: { url: "http://ct.example:7650" },
  features: { midFlightChunking: true },
};

describe("loadHookConfig", () => {
  test("a config with no `system` block still yields usable chunk tunables", () => {
    // The observed bug: this parsed cleanly, then threw on first dereference inside a
    // handler, where the error is caught and logged — so the chunk flush never ran and
    // nothing anywhere said so. Defaults belong at the boundary, not at each use site.
    const cfg = loadHookConfig(writeConfig(MINIMAL));
    expect(cfg?.system.logging.chunk).toEqual({
      maxEntriesPerChunk: 200,
      flushIntervalMs: 15000,
    });
  });

  test("chunk tunables at the wrong level are replaced by defaults, not inherited", () => {
    // A real config in the wild put these at top level. Reading them from there would
    // bless the mistake; the point is that the documented location keeps working.
    const cfg = loadHookConfig(
      writeConfig({ ...MINIMAL, logging: { chunk: { maxEntriesPerChunk: 7 } } }),
    );
    expect(cfg?.system.logging.chunk.maxEntriesPerChunk).toBe(200);
  });

  test("a partial chunk block is completed rather than rejected", () => {
    const cfg = loadHookConfig(
      writeConfig({ ...MINIMAL, system: { logging: { chunk: { flushIntervalMs: 99 } } } }),
    );
    expect(cfg?.system.logging.chunk).toEqual({ maxEntriesPerChunk: 200, flushIntervalMs: 99 });
  });

  test("no webapi → null, not a config that throws later", () => {
    // Nothing can default a target to write to. Returning null routes into the caller's
    // existing "not recording" path, which says so on SessionStart, instead of throwing
    // past every handler and killing the event — mirrors included.
    expect(loadHookConfig(writeConfig({ features: {} }))).toBeNull();
    expect(loadHookConfig(writeConfig({ webapi: {} }))).toBeNull();
  });

  test("a webapi-only config is complete — no store block needed (#288)", () => {
    const cfg = loadHookConfig(writeConfig({ webapi: { url: "https://ct.example" } }));
    expect(cfg?.webapi.url).toBe("https://ct.example");
    expect(cfg?.features).toEqual({});
  });

  test("a legacy config with stores AND a webapi records through the webapi", () => {
    const cfg = loadHookConfig(
      writeConfig({
        couch: { url: "http://127.0.0.1:5984", databases: { sessions: "s" }, auth: "a:b" },
        blob: { endpoint: "http://127.0.0.1:3900", accessKey: "k", secretKey: "s" },
        webapi: { url: "http://127.0.0.1:7650" },
      }),
    );
    expect(cfg?.webapi.url).toBe("http://127.0.0.1:7650");
  });

  test("a legacy config with stores but no webapi is NOT recording — and says why", () => {
    // Before #288 this was the normal, healthy config. It must not look like one now.
    const path = writeConfig({ couch: { url: "http://127.0.0.1:5984", databases: {} } });
    expect(loadHookConfig(path)).toBeNull();
    expect(hookConfigProblem(path)).toContain("no webapi");
    expect(hookConfigProblem(path)).toContain("claude-transcripts setup");
  });

  test("hookConfigProblem: a missing file is 'not installed', a good one is no problem", () => {
    expect(hookConfigProblem("/nonexistent/ct/config.json")).toContain("install");
    expect(hookConfigProblem(writeConfig(MINIMAL))).toBeNull();
  });

  test("normalize leaves everything it doesn't own alone", () => {
    const raw = { ...MINIMAL, mirrors: [{ url: "https://m.example" }] } as unknown as HookConfig;
    const out = normalizeHookConfig(raw);
    expect(out.mirrors).toEqual([{ url: "https://m.example" }]);
    expect(out.features).toEqual({ midFlightChunking: true });
  });
});
