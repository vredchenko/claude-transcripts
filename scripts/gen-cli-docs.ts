#!/usr/bin/env bun
/**
 * Generate the CLI command reference from the app model — a PROJECTION of CLI_SPEC
 * (`toCliDocs`), spliced into the hand-written pages between markers:
 *
 *   packages/cli/README.md     summary tables (the npm landing page)
 *   docs/reference/cli.md      tables + a section per command
 *
 * Edit the spec (packages/shared/src/model/cli.ts), not the generated region; CI runs
 * `gen:all` and fails on a diff, so the docs can't disagree with the binary.
 *
 *   bun run scripts/gen-cli-docs.ts   (or: bun run gen:cli-docs)
 */
import { join } from "node:path";
import { CLI_SPEC, toCliDocs } from "@claude-transcripts/shared";
import { spliceBetweenMarkers } from "./lib/markers";

const ROOT = join(import.meta.dir, "..");
const BIN = "claude-transcripts";

const targets: { path: string; detail: boolean }[] = [
  { path: "packages/cli/README.md", detail: false },
  { path: "docs/reference/cli.md", detail: true },
];

for (const { path, detail } of targets) {
  const changed = spliceBetweenMarkers(
    join(ROOT, path),
    "cli-docs",
    toCliDocs(CLI_SPEC, BIN, detail),
  );
  console.log(`[gen-cli-docs] ${path}${changed ? " updated" : " unchanged"}`);
}
