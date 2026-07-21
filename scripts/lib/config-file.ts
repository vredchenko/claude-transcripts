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
