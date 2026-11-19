/**
 * The CLI's own version: the lockstep app version from `package.json` (#289), bundled
 * into the compiled binary — no build flag, nothing to forget to pass. Spelled `vX.Y.Z`,
 * like the tag and the app image `install` pins to it.
 *
 * There are no dev builds. A source checkout reports the version of the tree it runs
 * from; {@link runningFromSource} lets `install` say so rather than pretend the
 * checkout is that release.
 */
import { APP_VERSION } from "@claude-transcripts/shared";

export const VERSION: string = APP_VERSION;

/**
 * True when this is `bun run packages/cli/src/cli.tsx` out of a checkout, not a compiled
 * binary (`/$bunfs/…`) or the npm bundle — i.e. code that may be ahead of the release
 * its `package.json` names.
 */
export function runningFromSource(path: string = import.meta.path): boolean {
  return /[\\/]packages[\\/]cli[\\/]src[\\/]/.test(path);
}
