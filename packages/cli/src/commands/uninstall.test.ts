import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installPaths } from "../lib/paths";
import { runUninstall } from "./uninstall";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CT_HOME;
  home = mkdtempSync(join(tmpdir(), "ct-uninstall-"));
  process.env.CT_HOME = home;
  const { deployDir } = installPaths();
  mkdirSync(join(deployDir, "data", "couchdb"), { recursive: true });
  writeFileSync(join(deployDir, "data", "couchdb", "_users.couch"), "history");
  writeFileSync(join(deployDir, "docker-compose.yml"), "services: {}\n");
  const { hookConfig } = installPaths();
  mkdirSync(dirname(hookConfig), { recursive: true });
  writeFileSync(hookConfig, JSON.stringify({ mirrors: [{ name: "backup" }] }));
});

afterEach(() => {
  if (prev === undefined) delete process.env.CT_HOME;
  else process.env.CT_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

// The stores are bind-mounted under deploy/data/; a plain uninstall used to rm -rf the
// whole deploy dir while printing "history kept".
test("plain uninstall keeps the stores' bind mounts and removes the rest", async () => {
  const { deployDir } = installPaths();
  expect(await runUninstall([])).toBe(0);
  expect(existsSync(join(deployDir, "data", "couchdb", "_users.couch"))).toBe(true);
  expect(existsSync(join(deployDir, "docker-compose.yml"))).toBe(false);
});

// Mirrors and a hand-set webapi URL live only in the hook config; install merges them
// forward from the file it replaces, so deleting it would drop them on reinstall.
// The statusline reads "configured" off that file, so it has to go with the hook.
test("plain uninstall keeps the hook config and deregisters the statusline", async () => {
  const { claudeSettings, hookConfig } = installPaths();
  mkdirSync(dirname(claudeSettings), { recursive: true });
  const statusLine = { type: "command", command: "claude-transcripts statusline render" };
  writeFileSync(claudeSettings, JSON.stringify({ statusLine }));
  expect(await runUninstall([])).toBe(0);
  expect(existsSync(hookConfig)).toBe(true);
  expect(JSON.parse(readFileSync(claudeSettings, "utf8")).statusLine).toBeUndefined();
});

test("--purge removes the history too", async () => {
  const { deployDir } = installPaths();
  expect(await runUninstall(["--purge", "--yes"])).toBe(0);
  expect(existsSync(deployDir)).toBe(false);
  expect(existsSync(installPaths().hookConfig)).toBe(false);
});
