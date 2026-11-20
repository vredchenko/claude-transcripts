/**
 * `claude-transcripts setup` — install/verify the logging hook + its runtime config.
 *
 *   claude-transcripts setup                       # write the config, check the webapi, register the hook
 *   claude-transcripts setup --webapi https://ct…  # the same, recording into a remote instance
 *   claude-transcripts setup --check               # verify an existing installation (read-only)
 *   claude-transcripts setup --no-hook             # config only (no Claude Code registration)
 *   claude-transcripts setup --project             # per-repo registration (PLACEHOLDER — not yet built)
 *
 * What it does:
 *  1. Write the hook runtime config to ~/.config/claude-transcripts/config.json (mode
 *     600) — the file the hook reads (packages/cli/src/hook/runtime.ts); nothing else
 *     writes it. It names only the webapi the hook writes through (#288): no store, no
 *     store credential. `--webapi` sets it; otherwise the env, then the URL already
 *     configured, then the local default.
 *  2. Check that webapi can take writes. Setup never touches a store: creating the
 *     databases, bucket and indexes is the webapi's and `install`/`provision`'s job.
 *  3. Register the hook with Claude Code. Scope is flexible: we inspect BOTH the
 *     project (`.claude/settings.json`) and global (~/.claude/settings.json) config
 *     to see what's already wired, then act. Only global is implemented today;
 *     per-repo is stubbed (registerProject).
 *
 * A client machine needs nothing but the instance's webapi URL. In a source checkout, use `--no-hook` so a dev run never registers a second
 * logger alongside the one already recording.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AppConfigFile, hookLaunch } from "@claude-transcripts/shared";
import { searchReindex } from "../api/generated";
import { setWebapiUrl } from "../api/http";
import { probeWebapi } from "../hook/ingest";
import { hookConfigProblem, loadHookConfig, redactUrl, redundantMirrorsIn } from "../hook/runtime";
import { loadAppConfig } from "../lib/app-config";
import { parseFlags, strOpt } from "../lib/args";
import { buildHookConfig, writeHookConfig } from "../lib/hook-config";
import { installPaths } from "../lib/paths";
import { type PluginRegistration, pluginRegistration } from "../lib/plugin";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HOOK_DIR = join(REPO_ROOT, "hooks");
const HOOK_CONFIG_PATH =
  process.env.CT_HOOK_CONFIG ?? join(homedir(), ".config", "claude-transcripts", "config.json");
// Via installPaths, not homedir(), so `CT_HOME` relocates it. `plugin.ts` derives the
// plugins directory from whatever path it is handed precisely so a sandboxed run reads
// the sandbox's plugins; passing it a real ~/.claude path would defeat that.
const GLOBAL_SETTINGS = installPaths().claudeSettings;
const PROJECT_SETTINGS = join(process.cwd(), ".claude", "settings.json");

/** True when this runs from a source checkout, not a compiled binary. */
const IN_CHECKOUT = existsSync(join(REPO_ROOT, "config", "config.template.json"));

/**
 * The app config the hook config is projected from: the checkout's `config/` when there
 * is one, else whatever {@link loadAppConfig} finds — an installed instance's
 * `app.json`, then the template embedded in the binary. A release binary has no
 * checkout (`REPO_ROOT` resolves to `/`), and reading the template from disk there is
 * what made `setup` crash on every client-only machine (#306).
 */
export function loadSetupConfig(root: string = REPO_ROOT): AppConfigFile {
  for (const name of ["config.json", "config.template.json"]) {
    const path = join(root, "config", name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as AppConfigFile;
  }
  return loadAppConfig();
}

// ── Write target ─────────────────────────────────────────────────────────────

/**
 * Can the configured webapi take writes now? Printed, not thrown: the config is
 * written either way, and an instance that is down today is still the right target.
 */
async function checkWebapi(): Promise<boolean> {
  const config = loadHookConfig(HOOK_CONFIG_PATH);
  if (!config) {
    console.error(`  ✗ not recording — ${hookConfigProblem(HOOK_CONFIG_PATH)}`);
    return false;
  }
  const target = redactUrl(config.webapi.url);
  for (const url of redundantMirrorsIn(HOOK_CONFIG_PATH)) {
    console.log(
      `  ! mirror ${redactUrl(url)} is the webapi itself — ignored; re-run setup to drop it`,
    );
  }
  const probe = await probeWebapi(config.webapi);
  if (probe.ok) {
    console.log(`  ✓ webapi ${target} takes writes`);
    return true;
  }
  console.error(
    `  ✗ webapi ${target}: ${probe.reason} — the hook will report every write as failed`,
  );
  console.error(
    "    bring the instance up (or re-run with `--webapi <url>`); sessions recorded " +
      "meanwhile are recovered with `claude-transcripts backfill`.",
  );
  return false;
}

// ── Hook registration (Claude Code settings) ─────────────────────────────────

type SettingsHooks = Record<string, Array<{ hooks: Array<{ command?: string }> }>>;

/**
 * The whole settings object, not just `hooks` — the plugin's registration lives under
 * `enabledPlugins`, and reading only `hooks` is what let this file conclude "nothing is
 * registered" on a machine that was recording perfectly well.
 */
function readSettings(path: string): Record<string, unknown> & { hooks?: SettingsHooks } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The plugin registration that makes registering here redundant, or null.
 *
 * Exported for the test: what was missing was never the detector — `plugin.ts` has
 * been able to see this all along — but this file asking it.
 */
export function globalRegistrationBlockedBy(
  settingsPath: string = GLOBAL_SETTINGS,
): PluginRegistration | null {
  return pluginRegistration(settingsPath, readSettings(settingsPath));
}

/** The dispatch shim's absolute path — settings.json can't use ${CLAUDE_PLUGIN_ROOT}. */
const DISPATCH_PATH = join(HOOK_DIR, "scripts", "dispatch.ts");

/** Our dispatch command, started from `/` so a deleted session cwd can't stop it (#171). */
function dispatchCommand(): string {
  return hookLaunch(`bun run "${DISPATCH_PATH}"`);
}

/** Is our hook already registered in the given settings file? */
function isRegistered(path: string): boolean {
  const cmd = dispatchCommand();
  const hooks = readSettings(path).hooks ?? {};
  return Object.values(hooks).some((groups) =>
    groups.some((g) => g.hooks.some((h) => h.command === cmd)),
  );
}

/**
 * Register the hook globally (~/.claude/settings.json). Reads the generated
 * registration (hooks/hooks/hooks.json) for the event set + per-event timeouts,
 * substitutes the absolute dispatch path, and MERGES (appends our group per event
 * — never clobbers other tools' hooks).
 */
function registerGlobal(dryRun: boolean): void {
  const cmd = dispatchCommand();
  const generated = JSON.parse(readFileSync(join(HOOK_DIR, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>
    >;
  };
  const settings = readSettings(GLOBAL_SETTINGS);
  const hooks: SettingsHooks = settings.hooks ?? {};

  for (const [event, groups] of Object.entries(generated.hooks)) {
    const timeout = groups[0]?.hooks[0]?.timeout;
    const ours = { hooks: [{ type: "command", command: cmd, ...(timeout ? { timeout } : {}) }] };
    // Drop any older spelling of this same command (before the `cd /` prefix), so
    // re-running setup upgrades a registration instead of adding a second writer.
    const existing = (hooks[event] ?? [])
      .map((g) => ({
        ...g,
        hooks: g.hooks.filter((h) => {
          const c = (h as { command?: string }).command;
          return c === cmd || !c?.includes(DISPATCH_PATH);
        }),
      }))
      .filter((g) => g.hooks.length > 0);
    const present = existing.some((g) =>
      g.hooks.some((h) => (h as { command?: string }).command === cmd),
    );
    hooks[event] = present ? existing : [...existing, ours];
  }

  if (dryRun) {
    console.log(
      `  [check] would register ${Object.keys(generated.hooks).length} events in ${GLOBAL_SETTINGS}`,
    );
    return;
  }
  mkdirSync(dirname(GLOBAL_SETTINGS), { recursive: true });
  writeFileSync(GLOBAL_SETTINGS, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  console.log(
    `  registered ${Object.keys(generated.hooks).length} events (system-wide) in ${GLOBAL_SETTINGS}`,
  );
}

/** PLACEHOLDER — per-repo registration into ./.claude/settings.json. */
function registerProject(): void {
  throw new Error(
    "per-repo (--project) registration is not implemented yet — use system-wide for now (see registerProject stub in setup.ts)",
  );
}

/** Report where the hook is already wired, so the user can choose scope. */
function reportExisting(): void {
  const g = isRegistered(GLOBAL_SETTINGS);
  const p = existsSync(PROJECT_SETTINGS) && isRegistered(PROJECT_SETTINGS);
  console.log(
    `  existing registration → global: ${g ? "yes" : "no"}, this project: ${p ? "yes" : "no"}`,
  );
  // Reported separately because it is a different mechanism, and because omitting it
  // was actively misleading: a plugin-registered machine records every event and this
  // line still said "no", which reads as "nothing is set up here".
  const plugin = globalRegistrationBlockedBy();
  if (plugin) {
    const version = plugin.version ? ` v${plugin.version}` : "";
    const count = plugin.events?.length;
    console.log(
      `  existing registration → plugin: ${plugin.key}${version}${count ? ` (${count} events)` : ""}`,
    );
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Say where search stands, and what to run if it isn't ready.
 *
 * `setup` configures the host side; the indexes are the webapi's. So this reports
 * rather than provisions — and tells the user the one command that fixes it, instead
 * of leaving them to discover `reindex` when a search comes back empty.
 */
async function reportSearch(): Promise<void> {
  try {
    const res = await searchReindex();
    if (!res.enabled) {
      console.log("  – search off (features.meilisearch false, or MEILI_HOST unset)");
      return;
    }
    console.log(
      `  ✓ search indexed ${res.sessions.indexed} session(s), ${res.turns.indexed + res.liveTurns.indexed} turn(s)`,
    );
  } catch {
    console.log("  – search not indexed (webapi unreachable) — run `claude-transcripts reindex`");
  }
}

export async function runSetup(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const check = options.check === true;
  const noHook = options["no-hook"] === true;
  const project = options.project === true;
  // The instance this machine records into. Explicit beats everything, so a client
  // can be pointed at a remote deployment with nothing else configured.
  const explicit = strOpt(options, "webapi")?.replace(/\/+$/, "");
  if (explicit) setWebapiUrl(explicit);

  if (IN_CHECKOUT) console.log(`setup: repo ${REPO_ROOT}`);
  const hookConfig = {
    ...buildHookConfig(loadSetupConfig(), process.env),
    ...(explicit ? { webapi: { url: explicit } } : {}),
  };
  reportExisting();

  if (check) {
    console.log("setup --check (read-only):");
    console.log(
      `  hook config: ${existsSync(HOOK_CONFIG_PATH) ? "present" : "MISSING"} (${HOOK_CONFIG_PATH})`,
    );
    return (await checkWebapi()) ? 0 : 1;
  }

  // 1. runtime config — webapi only; a legacy store block is dropped with its credentials.
  const dropped = writeHookConfig(HOOK_CONFIG_PATH, hookConfig);
  console.log(`  wrote hook config → ${HOOK_CONFIG_PATH} (mode 600)`);
  for (const url of dropped) {
    console.log(`  dropped mirror ${url} — it is the webapi itself, and would write twice`);
  }

  // 2. the write target. Search is reported the same way: the indexes are the
  // webapi's (ADR 0016), so setup says where they stand rather than configuring them.
  const reachable = await checkWebapi();
  if (reachable) await reportSearch();

  // 3. register the hook
  if (noHook) {
    console.log("  --no-hook: skipped Claude Code registration (config only)");
  } else if (project) {
    registerProject();
  } else {
    // Skip rather than double-write. The plugin registers the same events and both
    // routes end at `claude-transcripts hook run`, so registering here as well makes
    // every event land twice — permanently, and silently, because the hook
    // swallows everything by design.
    //
    // `hook install` has refused this since it learned to look; `setup` never did, and
    // `setup` is the command the docs tell you to run first and the one `install`
    // calls. The guard was on the door you reach for second.
    //
    // Skipped, not failed: step 1 did real work, and a machine recording via
    // the plugin is already in the state `setup` exists to produce. Nothing is wrong
    // here, so nothing should exit non-zero.
    const plugin = globalRegistrationBlockedBy();
    if (plugin) {
      console.log(`  the plugin ${plugin.key} already registers these events — skipped.`);
      console.log("  registering here as well would write every event twice.");
      console.log("  keep the plugin        → nothing to do (`hook status` explains it)");
      console.log("  use this binary instead → disable the plugin, then re-run setup");
    } else {
      registerGlobal(false);
    }
  }

  console.log("setup: done. Verify with `claude-transcripts doctor` (write→read→search).");
  return reachable ? 0 : 1;
}
