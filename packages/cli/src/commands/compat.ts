/**
 * `claude-transcripts compat` — does this Claude Code fire the hook events, with the
 * payloads, that this build was made for? (ADR 0025)
 *
 *   claude-transcripts compat                          # check the installed Claude Code
 *   claude-transcripts compat --cc-version 2.1.300     # check another version
 *   claude-transcripts compat fetch --cc-version X     # cache X's spec (the hook runs this)
 *
 * `check` exits 1 on drift, so it can gate a script. A version this build doesn't ship
 * the spec for is fetched from npm and cached, the same as the hook's background fetch.
 */
import {
  compareHookSpec,
  formatHookCompat,
  HOOK_TYPES,
  type HookSpec,
  hasDrift,
  VERIFIED_HOOK_SPEC,
} from "@claude-transcripts/shared";
import { parseFlags, strOpt } from "../lib/args";
import {
  cacheHookSpec,
  claudeCodeVersion,
  fetchHookSpec,
  knownHookSpec,
} from "../lib/claude-code-spec";

async function specFor(version: string): Promise<HookSpec> {
  const known = knownHookSpec(version);
  if (known) return known;
  const spec = await fetchHookSpec(version);
  cacheHookSpec(spec);
  return spec;
}

export async function runCompat(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const action = positionals[0] ?? "check";
  const version = strOpt(options, "cc-version") ?? claudeCodeVersion();
  if (!version) {
    console.error("compat: can't tell which Claude Code is installed — pass --cc-version");
    return 2;
  }

  let spec: HookSpec;
  try {
    spec = await specFor(version);
  } catch (err) {
    console.error(`compat: no hook spec for Claude Code ${version}: ${(err as Error).message}`);
    return 2;
  }
  if (action === "fetch") {
    if (!options.json) console.log(`compat: hook spec for Claude Code ${version} (${spec.sdk})`);
    return 0;
  }

  const report = compareHookSpec(HOOK_TYPES, VERIFIED_HOOK_SPEC, version, spec);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatHookCompat(report)) {
      if (!line.includes("claude-transcripts compat")) console.log(line);
    }
    console.log(
      `\nchecked against: Claude Code ${version} via @anthropic-ai/claude-agent-sdk@${spec.sdk}` +
        `\nthis build:      verified on Claude Code ${VERIFIED_HOOK_SPEC.claudeCode}`,
    );
  }
  return hasDrift(report) ? 1 : 0;
}
