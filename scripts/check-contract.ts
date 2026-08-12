#!/usr/bin/env bun
/**
 * Fail when a change breaks the API contract for consumers built against the baseline.
 *
 *   bun run check:contract                       # compare against origin/main
 *   CONTRACT_BASE=v0.0.7 bun run check:contract  # or any git ref
 *
 * The webapi's OpenAPI document is the contract's source of truth
 * ([ADR 0019](../docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)),
 * and consumers are *generated* from it. So a breaking change doesn't fail here — it
 * fails at somebody else's next codegen, or silently at runtime in a CLI shipped a
 * version ago. Nothing else in the repo can see that: the webapi's own tests pass and
 * the clients regenerate perfectly well against a contract that just deleted a field.
 *
 * ## Intentional breaks
 *
 * Breaking the contract is allowed — it's a Tier-1, pre-1.0 project and the alternative
 * is a frozen API. What isn't allowed is breaking it *silently*. So a break passes if
 * the commits introducing it say so, in the Conventional Commits form the repo already
 * uses (`feat(webapi)!:` — see `a329b2e` — or a `BREAKING CHANGE:` footer). The
 * acknowledgement lands in the history and the changelog, which is where someone
 * debugging a broken client will look.
 *
 * Dev-only automation; see the operational-utility rule in CLAUDE.md.
 */
import { join } from "node:path";
import { $ } from "bun";
import {
  type ContractChange,
  diffContract,
  formatChanges,
  type OpenApiDoc,
} from "../packages/webapi/src/contract-diff";

const ROOT = join(import.meta.dir, "..");
const SPEC = "openapi.json";
const BASE = process.env.CONTRACT_BASE || "origin/main";

/** Read the committed spec at a git ref, or null when it isn't there. */
async function specAt(ref: string): Promise<OpenApiDoc | null> {
  try {
    const text = await $`git show ${`${ref}:${SPEC}`}`.cwd(ROOT).quiet().text();
    return JSON.parse(text) as OpenApiDoc;
  } catch {
    return null;
  }
}

/** The spec this working tree produces, built offline from the route definitions. */
async function currentSpec(): Promise<OpenApiDoc> {
  const { buildOpenApiDocument } = await import("../packages/webapi/src/openapi");
  return buildOpenApiDocument() as unknown as OpenApiDoc;
}

/**
 * Do the commits since `ref` declare a breaking change?
 *
 * Conventional Commits marks one with `!` before the colon (`feat(webapi)!: …`) or a
 * `BREAKING CHANGE:` footer. Both are checked across every commit in the range, since
 * the break and its declaration needn't be in the same commit.
 */
async function breakIsDeclared(ref: string): Promise<boolean> {
  try {
    const log = await $`git log ${`${ref}..HEAD`} --format=%B`.cwd(ROOT).quiet().text();
    return /^[a-z]+(\([^)]*\))?!:/m.test(log) || /BREAKING[ -]CHANGE/.test(log);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const before = await specAt(BASE);
  if (!before) {
    // The first run on a branch whose baseline predates the committed spec, or a
    // shallow clone with no `origin/main`. Skipping loudly beats failing on an
    // absence that says nothing about the contract.
    console.log(
      `[contract] no ${SPEC} at ${BASE} — nothing to compare against, skipping.\n` +
        "[contract] (in CI this usually means the checkout is shallow: needs fetch-depth: 0)",
    );
    return;
  }

  const after = await currentSpec();
  const changes = diffContract(before, after);
  const breaks = changes.filter((c: ContractChange) => c.breaking);

  if (changes.length === 0) {
    console.log(`[contract] unchanged since ${BASE}.`);
    return;
  }

  console.log(`[contract] ${changes.length} change(s) since ${BASE}:\n`);
  console.log(formatChanges(changes));
  console.log("");

  if (breaks.length === 0) {
    console.log("[contract] all additive — consumers built against the baseline still work.");
    return;
  }

  if (await breakIsDeclared(BASE)) {
    console.log(
      `[contract] ${breaks.length} breaking change(s), declared by a commit ` +
        "(`type!:` or `BREAKING CHANGE:`). Allowed.",
    );
    return;
  }

  console.error(
    `[contract] ${breaks.length} breaking change(s) and nothing says so.\n\n` +
      "Consumers are generated from this spec, so this breaks them at their next\n" +
      "codegen — or silently at runtime for one that hasn't regenerated.\n\n" +
      "If the break is intended, say so in a commit: mark it `feat(webapi)!: …` or\n" +
      "add a `BREAKING CHANGE:` footer, so it reaches the changelog and whoever ends\n" +
      "up debugging a client that stopped working.",
  );
  process.exit(1);
}

await main();
