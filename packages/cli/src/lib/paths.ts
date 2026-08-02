/**
 * Where an installed instance keeps its files.
 *
 * A user install has **no repo**: the binary, its generated instance env, the
 * deployment assets it writes out, and the hook's runtime config all live under the
 * user's XDG directories (installation.md). Everything that needs a path asks here, so
 * there is exactly one definition of the layout.
 *
 * `CT_HOME` relocates the whole instance. That's what makes the installer testable —
 * a test (or a second experimental install) can point at a scratch directory instead
 * of the real `~/.config`, without a code path that only exists for tests.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstallPaths {
  /** Per-instance config: hook runtime config + the generated instance env. */
  configDir: string;
  /** Deployment assets written out of the binary (compose files, config template). */
  dataDir: string;
  /** Where the `claude-transcripts` binary is installed. */
  binDir: string;
  /** Hook runtime config — the file the hook itself reads. */
  hookConfig: string;
  /** Generated secrets + ports; the compose `--env-file` and our own source of truth. */
  instanceEnv: string;
  /** App config (features, store names, servicesMenu). */
  appConfig: string;
  /** Deployment assets directory. */
  deployDir: string;
  /** Version the written-out assets belong to. */
  versionFile: string;
  /** Claude Code's global settings — where the hook is registered. */
  claudeSettings: string;
}

function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v?.trim() ? v : fallback;
}

/**
 * Resolve the instance layout. With `CT_HOME` set, every path lives under it —
 * including the Claude Code settings file, so a sandboxed run can't register a hook
 * into the real Claude Code.
 */
export function installPaths(): InstallPaths {
  const home = homedir();
  const ctHome = process.env.CT_HOME;

  const configDir = ctHome
    ? join(ctHome, "config")
    : join(xdg("XDG_CONFIG_HOME", join(home, ".config")), "claude-transcripts");
  const dataDir = ctHome
    ? join(ctHome, "data")
    : join(xdg("XDG_DATA_HOME", join(home, ".local", "share")), "claude-transcripts");
  const binDir = ctHome ? join(ctHome, "bin") : join(home, ".local", "bin");
  const claudeSettings = ctHome
    ? join(ctHome, "claude", "settings.json")
    : join(home, ".claude", "settings.json");

  return {
    configDir,
    dataDir,
    binDir,
    claudeSettings,
    // CT_HOOK_CONFIG stays honoured on its own: the hook has read it since before any
    // of this existed, and existing installs point at it.
    hookConfig: process.env.CT_HOOK_CONFIG ?? join(configDir, "config.json"),
    instanceEnv: join(configDir, "instance.env"),
    appConfig: join(configDir, "app.json"),
    deployDir: join(dataDir, "deploy"),
    versionFile: join(dataDir, "version"),
  };
}

/** True when this process is running against a relocated (sandboxed) instance. */
export function isSandboxed(): boolean {
  return Boolean(process.env.CT_HOME);
}
