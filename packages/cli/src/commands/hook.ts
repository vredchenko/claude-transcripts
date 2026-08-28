/**
 * `claude-transcripts hook` — the Claude Code hook, and its registration.
 *
 *   claude-transcripts hook run         # dispatch one payload from stdin (Claude Code calls this)
 *   claude-transcripts hook install     # register with Claude Code
 *   claude-transcripts hook uninstall   # deregister (leaves other tools' hooks alone)
 *   claude-transcripts hook status      # what's registered, where, and any mirrors
 *
 * `run` is what gets registered, so a user needs neither Bun nor a repo checkout —
 * the binary is the hook (installation.md). Registration MERGES into
 * `~/.claude/settings.json`: other tools' hooks are never touched, and re-running is a
 * no-op.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dispatch, hookBindings, hookTimeout } from "../hook";
import { parseFlags } from "../lib/args";
import { installPaths } from "../lib/paths";

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  hooks: HookEntry[];
}
type SettingsHooks = Record<string, HookGroup[]>;

function readSettings(path: string): Record<string, unknown> & { hooks?: SettingsHooks } {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The command Claude Code should invoke.
 *
 * `process.execPath` is the compiled binary for a real install. Running from source
 * (a checkout) it's the `bun` binary instead, so we spell out the entry script —
 * otherwise a contributor's registration would point at bare `bun`.
 */
export function hookCommand(): string {
  return `${cliInvocation()} hook run`;
}

/** How to invoke *this* CLI from a Claude Code setting — see {@link hookCommand}. */
export function cliInvocation(): string {
  const exec = process.execPath;
  const isCompiled = !/\/bun$/.test(exec);
  if (isCompiled) return exec;
  return `${exec} run ${Bun.main}`;
}

/**
 * Is this command one of ours?
 *
 * Matches every form the registration has taken — the installed binary
 * (`…/claude-transcripts hook run`) and a checkout running from source
 * (`bun run …/cli.tsx hook run`) — because `install` has to recognise, and replace, a
 * registration it didn't itself write.
 */
function isOurCommand(command: string | undefined): boolean {
  if (!command?.includes("hook run")) return false;
  return command.includes("claude-transcripts") || command.includes("cli.tsx");
}

/** Every registration of ours currently in the file, as `event: command`. */
function findRegistered(settings: { hooks?: SettingsHooks }): string[] {
  const found: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (isOurCommand(h.command)) found.push(`${event}: ${h.command}`);
      }
    }
  }
  return found;
}

function install(argv: string[]): number {
  const { options } = parseFlags(argv);
  const paths = installPaths();
  const command = hookCommand();
  const settings = readSettings(paths.claudeSettings);
  const hooks: SettingsHooks = settings.hooks ?? {};
  const events = Object.keys(hookBindings());

  let added = 0;
  let replaced = 0;
  for (const event of events) {
    const existing = hooks[event] ?? [];
    // Drop any registration of OURS that isn't the command we're about to write. It
    // used to skip only on an exact string match, so switching form — a checkout
    // running from source, then the installed binary — left both registered and every
    // event fired two writers, double-writing events into CouchDB. Other tools' hooks
    // are matched by `isOurCommand` and never touched.
    const cleaned: HookGroup[] = [];
    for (const g of existing) {
      const kept = (g.hooks ?? []).filter((h) => {
        if (h.command === command) return true;
        if (isOurCommand(h.command)) {
          replaced++;
          return false;
        }
        return true;
      });
      if (kept.length) cleaned.push({ ...g, hooks: kept });
    }
    if (cleaned.some((g) => g.hooks?.some((h) => h.command === command))) {
      hooks[event] = cleaned;
      continue;
    }
    hooks[event] = [
      ...cleaned,
      { hooks: [{ type: "command", command, timeout: hookTimeout(event) }] },
    ];
    added++;
  }

  if (options["dry-run"] === true) {
    console.log(
      `hook: would register ${added} event(s)` +
        `${replaced ? `, replacing ${replaced} stale one(s)` : ""} in ${paths.claudeSettings}`,
    );
    return 0;
  }

  mkdirSync(dirname(paths.claudeSettings), { recursive: true });
  writeFileSync(paths.claudeSettings, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  const suffix = replaced ? ` (replaced ${replaced} stale registration(s))` : "";
  console.log(
    added
      ? `hook: registered ${added} event(s)${suffix} → ${paths.claudeSettings}`
      : `hook: already registered (${events.length} events)${suffix} → ${paths.claudeSettings}`,
  );
  // Claude Code snapshots hook config when a session starts, so anything already open
  // keeps the old (or no) registration until it restarts. Silence here is the bug we
  // spent a day diagnosing once.
  if (added) console.log("hook: restart any open Claude Code session for it to take effect.");
  return 0;
}

function uninstall(): number {
  const paths = installPaths();
  const settings = readSettings(paths.claudeSettings);
  if (!settings.hooks) {
    console.log("hook: nothing registered.");
    return 0;
  }
  let removed = 0;
  const hooks: SettingsHooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    // Drop only our groups; anything another tool registered stays exactly as it was.
    const kept = groups.filter((g) => {
      const ours = g.hooks?.some(
        (h) => h.command?.includes("claude-transcripts") && h.command.includes("hook run"),
      );
      if (ours) removed++;
      return !ours;
    });
    if (kept.length) hooks[event] = kept;
  }
  writeFileSync(paths.claudeSettings, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  console.log(`hook: removed ${removed} registration(s) from ${paths.claudeSettings}`);
  return 0;
}

/**
 * Mirror targets from the hook's own config, for display.
 *
 * Read straight from the file rather than through `loadHookConfig` so that a config
 * too broken to run still reports what it *says* — status exists to explain a hook
 * that isn't working.
 */
function configuredMirrors(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mirrors?: { url?: string }[];
    };
    return (parsed.mirrors ?? []).map((m) => m?.url ?? "(no url)");
  } catch {
    return [];
  }
}

function status(): number {
  const paths = installPaths();
  const settings = readSettings(paths.claudeSettings);
  const found = findRegistered(settings);
  console.log(`hook: settings   ${paths.claudeSettings}`);
  console.log(
    `hook: config     ${paths.hookConfig} ${existsSync(paths.hookConfig) ? "" : "(MISSING — run `install`)"}`,
  );
  console.log(`hook: command    ${hookCommand()}`);
  // Mirroring is otherwise invisible: it is configured by hand, writes to somewhere
  // else, and fails silently by design (mirrors.md). Somewhere has to say it is on.
  const mirrors = configuredMirrors(paths.hookConfig);
  for (const url of mirrors) console.log(`hook: mirror     ${url}`);
  if (!found.length) {
    console.log("hook: not registered.");
    return 1;
  }
  console.log(
    `hook: registered for ${found.length} event(s)` +
      (mirrors.length ? `, mirroring to ${mirrors.length}` : ""),
  );
  return 0;
}

/**
 * Dispatch one payload. Always exits 0: Claude Code treats a non-zero hook as a
 * problem, and a logging tool must never become one.
 */
async function run(): Promise<number> {
  try {
    const raw = await Bun.stdin.text();
    await dispatch(raw, installPaths().hookConfig);
  } catch (err) {
    console.error("[hook] dispatch failed (ignored):", err);
  }
  return 0;
}

export async function runHook(argv: string[]): Promise<number> {
  const [sub = "status", ...rest] = argv;
  switch (sub) {
    case "run":
      return run();
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall();
    case "status":
      return status();
    default:
      console.error(`hook: unknown subcommand "${sub}" (run | install | uninstall | status)`);
      return 2;
  }
}
