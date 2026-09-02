/**
 * Detect the Claude Code plugin's own hook registration.
 *
 * The plugin registers the same eleven events this CLI does, from its own
 * `hooks/hooks.json`, and both routes end at `claude-transcripts hook run` — so with
 * both active every event is written twice, forever, with no error and no warning.
 *
 * Nothing in `settings.json` records that, which is the whole problem: `hook status`
 * reads the settings file, finds nothing, and reports a bare "not registered" on a
 * machine that is recording perfectly well. The obvious remedy for that message is
 * `hook install`, and running it is what causes the double-write. `hook.ts` already
 * guards the equivalent case *within* the settings file (a source checkout and an
 * installed binary both registered), but a plugin's hooks live outside its reach:
 * `isOurCommand` matches on the string `hook run`, and the plugin's command is
 * `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts`.
 *
 * So the two routes are mutually exclusive and nothing could tell you which one you
 * were on. This module is what tells you.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The plugin's name in its manifest; the half of an `enabledPlugins` key before `@`. */
const PLUGIN_NAME = "claude-transcripts";

export interface PluginRegistration {
  /** The full `plugin@marketplace` key, as Claude Code writes it. */
  key: string;
  /** Version from `installed_plugins.json`, when it can be read. */
  version?: string;
  /** Events the plugin's `hooks.json` registers, when it can be read. */
  events?: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Absent or unparseable is the ordinary case — no plugins installed, or a settings
    // file we are only reading opportunistically. Never a reason to fail a command.
    return null;
  }
}

/**
 * Where Claude Code keeps plugin state, derived from the settings path.
 *
 * Taken from `installPaths().claudeSettings` rather than `homedir()` so that `CT_HOME`
 * relocates this too — a sandboxed run must not read the real Claude Code's plugins.
 */
function pluginsDir(settingsPath: string): string {
  return join(dirname(settingsPath), "plugins");
}

/**
 * Best-effort: the events the installed plugin registers.
 *
 * Only for display, so every failure degrades to `undefined` rather than throwing —
 * a plugin whose layout we can't read is still a plugin we must report.
 */
function pluginEvents(settingsPath: string, key: string): string[] | undefined {
  const installed = readJson(join(pluginsDir(settingsPath), "installed_plugins.json"));
  const entry = (installed?.plugins as Record<string, unknown> | undefined)?.[key];
  const first = Array.isArray(entry)
    ? (entry[0] as Record<string, unknown> | undefined)
    : undefined;
  const installPath = typeof first?.installPath === "string" ? first.installPath : undefined;
  if (!installPath) return undefined;

  const hooks = readJson(join(installPath, "hooks", "hooks.json"));
  const events = hooks?.hooks;
  if (!events || typeof events !== "object") return undefined;
  return Object.keys(events);
}

/** Best-effort: the installed version, for the status line. */
function pluginVersion(settingsPath: string, key: string): string | undefined {
  const installed = readJson(join(pluginsDir(settingsPath), "installed_plugins.json"));
  const entry = (installed?.plugins as Record<string, unknown> | undefined)?.[key];
  const first = Array.isArray(entry)
    ? (entry[0] as Record<string, unknown> | undefined)
    : undefined;
  return typeof first?.version === "string" ? first.version : undefined;
}

/**
 * The plugin's registration, or null when it isn't providing one.
 *
 * `enabledPlugins` is the authority rather than the on-disk plugin cache: a plugin can
 * be installed but switched off, and a disabled plugin registers nothing. An explicit
 * `false` therefore means "not registering", not "unknown".
 */
export function pluginRegistration(
  settingsPath: string,
  settings: Record<string, unknown>,
): PluginRegistration | null {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return null;

  for (const [key, on] of Object.entries(enabled as Record<string, unknown>)) {
    if (on !== true) continue;
    // `plugin@marketplace` — match the plugin half, so the same plugin counts however
    // it was vendored (the repo's own marketplace, a fork, or a local path install).
    if (key.split("@")[0] !== PLUGIN_NAME) continue;
    return {
      key,
      version: pluginVersion(settingsPath, key),
      events: pluginEvents(settingsPath, key),
    };
  }
  return null;
}
