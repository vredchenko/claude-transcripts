#!/usr/bin/env bun
/**
 * Generate the distribution matrix in docs/reference/distributions.md from the
 * blueprint — a PROJECTION of DISTRIBUTIONS (`toDistributionsDoc`), spliced between
 * markers so the prose around it stays hand-written.
 *
 * Edit packages/shared/src/blueprint/distributions.ts, not the generated region; CI runs
 * `gen:all` and fails on a diff.
 *
 *   bun run scripts/gen-distributions.ts   (or: bun run gen:distributions)
 */
import { join } from "node:path";
import { toDistributionsDoc } from "@claude-transcripts/shared";
import { spliceBetweenMarkers } from "./lib/markers";

const ROOT = join(import.meta.dir, "..");
const path = "docs/reference/distributions.md";
const changed = spliceBetweenMarkers(join(ROOT, path), "distributions", toDistributionsDoc());
console.log(`[gen-distributions] ${path}${changed ? " updated" : " unchanged"}`);
