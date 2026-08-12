/**
 * Webapi URL resolution.
 *
 * `install` generates a port per instance, so an install is frequently not on the
 * default 7650 — and the resolver reading only env meant every command reported a dead
 * webapi on a port nothing was listening on unless told `--webapi`. These pin the
 * precedence that fixes that, including the env overrides a dev checkout depends on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebapiUrl } from "./http";

const SAVED = { ...process.env };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ct-http-"));
  for (const k of ["CT_WEBAPI_URL", "WEBAPI_HOST", "WEBAPI_PORT"]) delete process.env[k];
  process.env.CT_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...SAVED };
});

/** Write an instance.env under the sandboxed CT_HOME. */
function writeInstanceEnv(body: string): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "instance.env"), body);
}

describe("resolveWebapiUrl", () => {
  test("falls back to the default when there is no install and no env", () => {
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
  });

  test("reads the installed instance's port", () => {
    writeInstanceEnv("WEBAPI_HOST=127.0.0.1\nWEBAPI_PORT=7658\nCOUCHDB_PORT=7660\n");
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7658");
  });

  test("CT_WEBAPI_URL wins over the instance file", () => {
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    process.env.CT_WEBAPI_URL = "http://example.test:9000/";
    // Trailing slash trimmed, since every caller concatenates a path onto it.
    expect(resolveWebapiUrl()).toBe("http://example.test:9000");
  });

  test("an explicit WEBAPI_PORT wins over the instance file", () => {
    // How a dev checkout points the CLI at a webapi it runs from source.
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    process.env.WEBAPI_PORT = "7650";
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
  });

  test("WEBAPI_HOST alone does not suppress the instance lookup", () => {
    // The template ships a WEBAPI_HOST and Bun loads it for anything run from a
    // checkout, so if the host counted as "a target was named" the lookup below would
    // never get a turn and every checkout would sit on a dead 7650.
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    process.env.WEBAPI_HOST = "127.0.0.1";
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7658");
  });

  test("an empty WEBAPI_PORT is not a pin", () => {
    // `WEBAPI_PORT=` in a .env is a blank, not a choice. Reading it as one produced a
    // portless `http://127.0.0.1:`, which fails at the socket rather than saying why.
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    process.env.WEBAPI_PORT = "";
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7658");
  });

  test("WEBAPI_HOST chooses the host when a port is pinned", () => {
    process.env.WEBAPI_HOST = "10.0.0.5";
    process.env.WEBAPI_PORT = "7650";
    expect(resolveWebapiUrl()).toBe("http://10.0.0.5:7650");
  });

  test("WEBAPI_HOST applies to the default when there is no install", () => {
    process.env.WEBAPI_HOST = "10.0.0.5";
    expect(resolveWebapiUrl()).toBe("http://10.0.0.5:7650");
  });

  test("an unreadable or portless instance file falls through", () => {
    writeInstanceEnv("COUCHDB_PORT=7660\n# no webapi port here\n");
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
  });
});
