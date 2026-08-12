import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTarget, instanceOrigin, resolveProxyTarget } from "./webapi-target";

const up = async () => true;
const down = async () => false;
const noInstance = () => null;

function tempEnv(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "ct-webui-")), "instance.env");
  writeFileSync(path, contents);
  return path;
}

describe("instanceOrigin", () => {
  test("reads host + port from an instance env", () => {
    expect(instanceOrigin(tempEnv("WEBAPI_HOST=127.0.0.1\nWEBAPI_PORT=7658\n"))).toBe(
      "http://127.0.0.1:7658",
    );
  });

  test("rewrites the container's 0.0.0.0 bind to localhost", () => {
    expect(instanceOrigin(tempEnv("WEBAPI_HOST=0.0.0.0\nWEBAPI_PORT=7658\n"))).toBe(
      "http://127.0.0.1:7658",
    );
  });

  test("defaults the host when only a port is written", () => {
    expect(instanceOrigin(tempEnv("APP_TAG=latest\nWEBAPI_PORT=7658\n"))).toBe(
      "http://127.0.0.1:7658",
    );
  });

  test("is quiet about a missing port or an unreadable file", () => {
    expect(instanceOrigin(tempEnv("APP_TAG=latest\n"))).toBeNull();
    expect(instanceOrigin(join(tmpdir(), "ct-does-not-exist", "instance.env"))).toBeNull();
  });
});

describe("resolveProxyTarget", () => {
  test("an explicit port wins over an installed instance", async () => {
    const t = await resolveProxyTarget({
      port: "7650",
      readInstance: () => "http://127.0.0.1:7658",
      probeOrigin: up,
    });
    expect(t).toMatchObject({ origin: "http://127.0.0.1:7650", source: "configured" });
  });

  test("falls back to the installed instance when nothing is configured", async () => {
    const t = await resolveProxyTarget({
      readInstance: () => "http://127.0.0.1:7658",
      probeOrigin: up,
    });
    expect(t).toMatchObject({
      origin: "http://127.0.0.1:7658",
      source: "instance",
      reachable: true,
    });
  });

  test("WEBAPI_HOST alone does not suppress the lookup — only a port pins the target", async () => {
    const t = await resolveProxyTarget({
      host: "127.0.0.1",
      readInstance: () => "http://127.0.0.1:7658",
      probeOrigin: up,
    });
    expect(t).toMatchObject({ origin: "http://127.0.0.1:7658", source: "instance" });
  });

  test("WEBAPI_HOST chooses the host when a port is pinned", async () => {
    const t = await resolveProxyTarget({
      host: "10.0.0.5",
      port: "7650",
      readInstance: noInstance,
      probeOrigin: up,
    });
    expect(t.origin).toBe("http://10.0.0.5:7650");
  });

  test("falls back to the documented default with no config and no install", async () => {
    const t = await resolveProxyTarget({ readInstance: noInstance, probeOrigin: up });
    expect(t).toMatchObject({ origin: "http://127.0.0.1:7650", source: "default" });
  });

  test("names the live instance when the configured port is dead", async () => {
    const t = await resolveProxyTarget({
      port: "7650",
      readInstance: () => "http://127.0.0.1:7658",
      probeOrigin: async (o) => o === "http://127.0.0.1:7658",
    });
    expect(t).toMatchObject({ reachable: false, alternative: "http://127.0.0.1:7658" });
  });

  test("offers no alternative when the instance is the dead target", async () => {
    const t = await resolveProxyTarget({
      port: "7658",
      readInstance: () => "http://127.0.0.1:7658",
      probeOrigin: down,
    });
    expect(t.alternative).toBeNull();
  });

  test("offers no alternative when the install is down too", async () => {
    const t = await resolveProxyTarget({
      port: "7650",
      readInstance: () => "http://127.0.0.1:7658",
      probeOrigin: down,
    });
    expect(t.alternative).toBeNull();
  });
});

describe("describeTarget", () => {
  test("reports the target and its provenance when healthy", () => {
    const msg = describeTarget({
      origin: "http://127.0.0.1:7658",
      source: "instance",
      reachable: true,
      alternative: null,
    });
    expect(msg).toContain("http://127.0.0.1:7658");
    expect(msg).toContain("the installed instance");
  });

  test("spells out the fix, with the port to use, when the target is dead", () => {
    const msg = describeTarget({
      origin: "http://127.0.0.1:7650",
      source: "configured",
      reachable: false,
      alternative: "http://127.0.0.1:7658",
    });
    expect(msg).toContain("nothing is listening on http://127.0.0.1:7650");
    expect(msg).toContain("WEBAPI_PORT=7658 bun run dev:webui");
    expect(msg).toContain("bun run dev:webapi");
  });

  test("still suggests running the webapi when there is no install to point at", () => {
    const msg = describeTarget({
      origin: "http://127.0.0.1:7650",
      source: "default",
      reachable: false,
      alternative: null,
    });
    expect(msg).toContain("nothing is listening");
    expect(msg).not.toContain("WEBAPI_PORT=");
    expect(msg).toContain("bun run dev:webapi");
  });
});
