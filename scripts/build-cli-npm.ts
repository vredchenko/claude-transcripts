#!/usr/bin/env bun
/**
 * Build the CLI into a single, bun-runnable bundle for npm publishing:
 * `packages/cli/dist/cli.js`. `bun build --target=bun` already emits a
 * `#!/usr/bin/env bun` shebang on line 1, so npm creates the `claude-transcripts`
 * launcher correctly; we just mark it executable.
 *
 *   bun run scripts/build-cli-npm.ts
 *
 * The CLI requires **bun** at runtime (it uses Bun APIs), so consumers run it via
 * `bunx @claude-transcripts/cli` or a global install with bun on PATH. The
 * zero-dependency alternative is the compiled binaries from GitHub Releases.
 */
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/cli/src/cli.tsx");
const OUT = join(ROOT, "packages/cli/dist/cli.js");

await $`bun build --target=bun ${ENTRY} --outfile ${OUT}`;
chmodSync(OUT, 0o755);
console.log(`[cli] npm bundle → ${OUT}`);
