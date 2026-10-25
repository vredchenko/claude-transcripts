/**
 * The session-start hook-spec check (ADR 0025): does the Claude Code running this
 * session fire the events, with the payloads, that this build was made for?
 *
 * Deterministic by construction. The version comes from the binary, the spec for that
 * version from an immutable npm release (shipped in this build, or cached), and the
 * comparison is a pure function of the two plus our catalogue. When this build doesn't
 * have the spec yet, nothing waits on the network: a detached `compat fetch` caches it
 * and the next session shows the result.
 */
import {
  compareHookSpec,
  formatHookCompat,
  HOOK_TYPES,
  type HookSpec,
  VERIFIED_HOOK_SPEC,
} from "@claude-transcripts/shared";
import { claudeCodeVersion, knownHookSpec } from "../lib/claude-code-spec";
import { cliArgv, spawnDetached } from "./detach";

export interface CompatDeps {
  version(): string | null;
  spec(version: string): HookSpec | null;
  /** Start a background fetch of `version`'s spec; false if it could not start. */
  fetch(version: string): boolean;
}

const REAL: CompatDeps = {
  version: () => claudeCodeVersion(),
  spec: knownHookSpec,
  fetch: (version) => spawnDetached([...cliArgv(), "compat", "fetch", "--cc-version", version]),
};

/** The banner lines for this session. Never throws — a failed check says so in one line. */
export function hookCompatLines(deps: CompatDeps = REAL): string[] {
  try {
    const version = deps.version();
    if (!version) return ["? Hook spec not checked — `claude --version` gave no answer"];
    const spec = deps.spec(version);
    if (!spec) deps.fetch(version);
    return formatHookCompat(compareHookSpec(HOOK_TYPES, VERIFIED_HOOK_SPEC, version, spec));
  } catch {
    return [];
  }
}
