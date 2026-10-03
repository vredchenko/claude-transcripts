import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("--purge removes the history too", async () => {
  const { deployDir } = installPaths();
  expect(await runUninstall(["--purge", "--yes"])).toBe(0);
  expect(existsSync(deployDir)).toBe(false);
});
