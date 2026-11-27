#!/usr/bin/env bun
/**
 * Project the blueprint's distribution facts into the files that state them, each
 * spliced between markers so everything around it stays hand-written:
 *
 * - docs/reference/distributions.md — the distribution matrix (`toDistributionsDoc`)
 * - the CLI release targets (`CLI_TARGETS`, ADR 0036) everywhere they are listed:
 *   release-cli.yml (build loop + smoke matrix), install.sh, the omnibus Dockerfile and
 *   downloads page, and the install docs
 *
 * Edit packages/shared/src/blueprint/{distributions,cli-targets}.ts, not the generated
 * regions; CI runs `gen:all` and fails on a diff.
 *
 *   bun run scripts/gen-distributions.ts   (or: bun run gen:distributions)
 */
import { join } from "node:path";
import {
  toCliBuildTargets,
  toCliSmokeMatrix,
  toCliTargetsDoc,
  toDistributionsDoc,
  toDownloadsRows,
  toInstallShTargets,
  toOmnibusTargets,
} from "@claude-transcripts/shared";
import { spliceBetweenMarkers } from "./lib/markers";

const ROOT = join(import.meta.dir, "..");

const regions: [path: string, key: string, body: string, style: "html" | "hash"][] = [
  ["docs/reference/distributions.md", "distributions", toDistributionsDoc(), "html"],
  ["docs/start/installation.md", "cli-targets", toCliTargetsDoc(), "html"],
  ["install.sh", "cli-targets", toInstallShTargets(), "hash"],
  [
    ".github/workflows/release-cli.yml",
    "cli-build-targets",
    `          targets="${toCliBuildTargets()}"`,
    "hash",
  ],
  [".github/workflows/release-cli.yml", "cli-smoke-matrix", toCliSmokeMatrix(), "hash"],
  [
    "deploy/omnibus/Dockerfile",
    "omnibus-cli-targets",
    `ARG CLI_TARGETS="${toOmnibusTargets()}"`,
    "hash",
  ],
  ["deploy/omnibus/downloads.html", "downloads-cli", toDownloadsRows(), "html"],
];

for (const [path, key, body, style] of regions) {
  const changed = spliceBetweenMarkers(join(ROOT, path), key, body, style);
  console.log(`[gen-distributions] ${path} (${key})${changed ? " updated" : " unchanged"}`);
}
