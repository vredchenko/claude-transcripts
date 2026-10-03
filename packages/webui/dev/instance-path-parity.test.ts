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
import { installPaths } from "../../cli/src/lib/paths";
import { instanceEnvPath } from "./webapi-target";

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

describe("instance.env path parity with the CLI", () => {
  test.each([
    ["the default location", {}],
    ["CT_HOME — how a sandboxed install relocates", { CT_HOME: "/tmp/ct-sandbox" }],
    ["XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "/tmp/xdg-config" }],
    ["CT_HOME outranking XDG_CONFIG_HOME", { CT_HOME: "/tmp/ct", XDG_CONFIG_HOME: "/tmp/xdg" }],
    ["a blank XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "   " }],
    // The CLI treats a non-blank value as opaque, padding included; the webui once
    // trimmed it, which is exactly the two-clients-disagree bug this file prevents.
    ["a padded XDG_CONFIG_HOME", { XDG_CONFIG_HOME: " /tmp/xdg-padded " }],
  ] as [string, Record<string, string>][])("agree under %s", (_name, env) => {
    for (const k of ["CT_HOME", "XDG_CONFIG_HOME"]) delete process.env[k];
    Object.assign(process.env, env);
    expect(instanceEnvPath()).toBe(installPaths().instanceEnv);
  });
});
