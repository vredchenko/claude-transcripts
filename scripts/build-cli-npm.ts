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
 *
 * This also stages the licence next to the manifest. npm auto-includes `LICENSE`
 * from the *package* directory, and `npm publish` runs from `packages/cli`, so the
 * repo-root file would otherwise never reach the tarball — leaving a package that
 * declares `"license": "MIT"` while shipping no licence text. Copied at build time
 * rather than committed, so there is no second copy to drift.
 */
import { chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/cli/src/cli.tsx");
const PKG_DIR = join(ROOT, "packages/cli");
const OUT = join(PKG_DIR, "dist/cli.js");
const LICENSE = join(PKG_DIR, "LICENSE");

await $`bun build --target=bun ${ENTRY} --outfile ${OUT}`;
chmodSync(OUT, 0o755);

copyFileSync(join(ROOT, "LICENSE"), LICENSE);

console.log(`[cli] npm bundle → ${OUT}`);
console.log(`[cli] licence    → ${LICENSE}`);
