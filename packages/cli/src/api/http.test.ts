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
  for (const k of ["CT_WEBAPI_URL", "WEBAPI_HOST", "WEBAPI_PORT", "CT_HOOK_CONFIG"]) {
    delete process.env[k];
  }
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

/** Write the hook runtime config under the sandboxed CT_HOME. */
function writeHookConfig(body: string): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "config.json"), body);
}

const REMOTE = JSON.stringify({
  couch: { url: "https://couch.example.com" },
  webapi: { url: "https://logs.example.com/" },
});

describe("resolveWebapiUrl — hook config", () => {
  test("a hook config naming a remote webapi wins over the instance file", () => {
    // A machine recording to a remote deployment: the hook writes there, so the CLI
    // must read from there too rather than a local install or localhost.
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    writeHookConfig(REMOTE);
    expect(resolveWebapiUrl()).toBe("https://logs.example.com");
  });

  test("CT_WEBAPI_URL and WEBAPI_PORT both win over the hook config", () => {
    writeHookConfig(REMOTE);
    process.env.WEBAPI_PORT = "7650";
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
    process.env.CT_WEBAPI_URL = "http://example.test:9000";
    expect(resolveWebapiUrl()).toBe("http://example.test:9000");
  });

  test("a hook config without webapi falls through to the instance file", () => {
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    writeHookConfig(JSON.stringify({ couch: { url: "http://127.0.0.1:7652" } }));
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7658");
  });

  test("a malformed hook config is ignored, not fatal", () => {
    writeHookConfig("{ not json");
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
    writeHookConfig(JSON.stringify({ webapi: { url: 42 } }));
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
  });
});

describe("resolveWebapiUrl", () => {
  test("reads the installed instance's port", () => {
    writeInstanceEnv("WEBAPI_HOST=127.0.0.1\nWEBAPI_PORT=7658\nCOUCHDB_PORT=7660\n");
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7658");
  });

  test("a 0.0.0.0 bind host in the instance file is dialled as loopback", () => {
    // That field records what the webapi BINDS. `0.0.0.0` is "every interface", not an
    // address to connect to — dialling it works on Linux and not everywhere else.
    writeInstanceEnv("WEBAPI_HOST=0.0.0.0\nWEBAPI_PORT=7658\n");
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7658");
  });

  test("CT_WEBAPI_URL wins over the instance file", () => {
    writeInstanceEnv("WEBAPI_PORT=7658\n");
    process.env.CT_WEBAPI_URL = "http://example.test:9000/";
    // Trailing slash trimmed, since every caller concatenates a path onto it.
    expect(resolveWebapiUrl()).toBe("http://example.test:9000");
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

  test("the base URL is resolved on first use, not at import", () => {
    // Set the port *after* the module is imported: resolving at import would have
    // baked in the default and ignored it. Also a subprocess, since this file's own
    // import happened before any test ran and cannot be re-timed.
    const r = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(join(import.meta.dir, "http.ts"))});
         process.env.WEBAPI_PORT = "7999";
         console.log(m.webapiUrl());`,
      ],
      cwd: home,
      env: { ...process.env, CT_HOME: home, CT_WEBAPI_URL: "", WEBAPI_HOST: "", WEBAPI_PORT: "" },
    });
    expect(r.stdout.toString().trim()).toBe("http://127.0.0.1:7999");
    expect(r.exitCode).toBe(0);
  });

  test("an unreadable or portless instance file falls through", () => {
    writeInstanceEnv("COUCHDB_PORT=7660\n# no webapi port here\n");
    expect(resolveWebapiUrl()).toBe("http://127.0.0.1:7650");
  });
});
