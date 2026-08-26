import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfigFile } from "@claude-transcripts/shared";

/** Read the raw config file (live config.json, else the committed template).
 *  Node/Bun-side only (fs) — shared/ stays isomorphic, so this lives in scripts. */
export function loadConfigFile(root: string): AppConfigFile {
  const dir = process.env.CT_CONFIG_DIR ?? join(root, "config");
  const live = join(dir, "config.json");
  const template = join(dir, "config.template.json");
  return JSON.parse(readFileSync(existsSync(live) ? live : template, "utf8")) as AppConfigFile;
}

/**
 * Read the committed template, never the live instance config.
 *
 * For generators whose output is committed and re-checked by CI's
 * `gen:all && git diff --exit-code`. `loadConfigFile` prefers the **gitignored**
 * `config/config.json`, so a contributor who has one — with, say, `meilisearch:
 * false` — would regenerate different bytes and fail the drift gate on their PR for
 * reasons invisible to them and unreproducible in CI. Pair this with an empty env
 * (`buildAppModel(loadConfigTemplate(root), {})`) so host ports resolve to the
 * documented defaults rather than the contributor's shell.
 *
 * The other generators are immune by accident: `gen-compose` emits `${VAR}`
 * placeholders rather than resolved values, so nothing env-dependent reaches disk.
 */
export function loadConfigTemplate(root: string): AppConfigFile {
  const dir = process.env.CT_CONFIG_DIR ?? join(root, "config");
  return JSON.parse(readFileSync(join(dir, "config.template.json"), "utf8")) as AppConfigFile;
}
