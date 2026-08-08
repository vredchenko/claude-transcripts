/**
 * Instance env merge rules.
 *
 * The distinction these pin down is what an upgrade may change. Ports and secrets are
 * the instance's and must survive; `APP_TAG` is derived from the CLI and must not,
 * because components are lockstep-versioned and a stale pin leaves an old image running
 * with no error anywhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateInstanceEnv } from "./instance-env";

function withTempEnv(body: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ct-env-"));
  const path = join(dir, "instance.env");
  writeFileSync(path, body);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadOrCreateInstanceEnv", () => {
  test("APP_TAG follows the CLI, overwriting what's on disk", () => {
    withTempEnv("APP_TAG=latest\nWEBAPI_PORT=7658\n", (path) => {
      const env = loadOrCreateInstanceEnv(path, { appTag: "0.0.4" });
      expect(env.APP_TAG).toBe("0.0.4");
      // …and is persisted, not just returned.
      expect(readFileSync(path, "utf8")).toContain("APP_TAG=0.0.4");
    });
  });

  test("the instance's own choices survive an upgrade", () => {
    withTempEnv("APP_TAG=latest\nWEBAPI_PORT=7658\nCOUCHDB_PASSWORD=keepme\n", (path) => {
      const env = loadOrCreateInstanceEnv(path, { appTag: "0.0.4" });
      // Ports and secrets belong to the instance — an upgrade must not relocate or
      // regenerate them.
      expect(env.WEBAPI_PORT).toBe("7658");
      expect(env.COUCHDB_PASSWORD).toBe("keepme");
    });
  });

  test("a fresh instance takes the pin too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-env-"));
    try {
      const env = loadOrCreateInstanceEnv(join(dir, "instance.env"), { appTag: "0.0.4" });
      expect(env.APP_TAG).toBe("0.0.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
