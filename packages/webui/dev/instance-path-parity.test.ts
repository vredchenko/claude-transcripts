/**
 * The webui's dev server and the CLI must agree on where an install keeps its
 * `instance.env`.
 *
 * `webapi-target.ts` re-derives that path instead of importing the CLI's
 * `installPaths()` — the webui does not depend on the CLI package, and a dev-server
 * config is a poor reason to make it. The cost of that choice is drift, and the comment
 * saying "keep the two in step" is a wish, not a mechanism. This is the mechanism.
 *
 * Drift here is quiet and annoying: the dev proxy stops finding the install and every
 * `/api` call fails, with nothing pointing at a path that moved.
 *
 * The import below crosses a package boundary on purpose. It is a *test* asserting two
 * implementations agree, not a dependency — nothing shipped in the SPA imports the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { installPaths } from "../../cli/src/lib/paths";
import { instanceEnvPath } from "./webapi-target";

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

/** Drop the vars both implementations read, so a case starts from nothing. */
function clearEnv(): void {
  for (const k of ["CT_HOME", "XDG_CONFIG_HOME"]) delete process.env[k];
}

describe("instance.env path parity with the CLI", () => {
  test("agree on the default location", () => {
    clearEnv();
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
    expect(instanceEnvPath()).toBe(
      join(homedir(), ".config", "claude-transcripts", "instance.env"),
    );
  });

  test("agree under CT_HOME — how a sandboxed install relocates", () => {
    clearEnv();
    process.env.CT_HOME = "/tmp/ct-sandbox";
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
    expect(instanceEnvPath()).toBe(join("/tmp/ct-sandbox", "config", "instance.env"));
  });

  test("agree under XDG_CONFIG_HOME", () => {
    clearEnv();
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
  });

  test("agree that CT_HOME outranks XDG_CONFIG_HOME", () => {
    clearEnv();
    process.env.CT_HOME = "/tmp/ct-sandbox";
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
    expect(instanceEnvPath()).toContain("/tmp/ct-sandbox");
  });

  test("agree that a blank XDG_CONFIG_HOME falls back to the home directory", () => {
    clearEnv();
    process.env.XDG_CONFIG_HOME = "   ";
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
    expect(instanceEnvPath()).toContain(homedir());
  });

  test("agree on a padded XDG_CONFIG_HOME, whichever way it is read", () => {
    // The CLI treats the value as opaque once it is non-blank, padding included. The
    // webui trimmed it, which is defensible in isolation and wrong here: two clients
    // resolving one path differently is the bug this file exists to prevent.
    clearEnv();
    process.env.XDG_CONFIG_HOME = " /tmp/xdg-padded ";
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
  });
});
