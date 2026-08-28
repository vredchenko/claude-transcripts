/**
 * `claude-transcripts statusline` — the Claude Code statusline indicator, and its
 * registration.
 *
 *   claude-transcripts statusline render      # Claude Code calls this on every refresh
 *   claude-transcripts statusline install     # set `statusLine` in ~/.claude/settings.json
 *   claude-transcripts statusline uninstall   # remove it (only if it is ours)
 *   claude-transcripts statusline status      # what's registered
 *
 * `render` is the hot path: it reads the statusline JSON on stdin, looks up the hook's
 * per-session scratch files, prints one line and exits. No network, ever, and nothing
 * it does can fail loudly — a broken indicator is worse than none.
 *
 * Registration lives here, not in the plugin, because a plugin's `settings.json` may
 * set `subagentStatusLine` but **not** `statusLine` (plugin.md, Part 1b). `statusLine`
 * is a single setting, so if the user already has one that isn't ours we print the
 * snippet and stop rather than overwrite it — never touch a key that isn't ours.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeCounts, makeTargets } from "../hook/runtime";
import { parseFlags } from "../lib/args";
import { installPaths } from "../lib/paths";
import { renderStatusline, type StatuslineInput } from "../lib/statusline";
import { cliInvocation } from "./hook";

interface StatusLineSetting {
  type?: string;
  command?: string;
  padding?: number;
}
type Settings = Record<string, unknown> & { statusLine?: StatusLineSetting };

function readSettings(path: string): Settings {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function statuslineCommand(): string {
  return `${cliInvocation()} statusline render`;
}

/** Ours in any form — the installed binary, a checkout, or the plugin's `bin/` wrapper. */
export function isOurStatusline(s: StatusLineSetting | undefined): boolean {
  const c = s?.command ?? "";
  return c.includes("claude-transcripts-statusline") || c.includes("statusline render");
}

async function render(): Promise<number> {
  try {
    let input: StatuslineInput = {};
    try {
      input = JSON.parse(await Bun.stdin.text()) as StatuslineInput;
    } catch {
      // no / bad JSON → render the config-only state
    }
    const configured = existsSync(installPaths().hookConfig);
    const id = input.session_id;
    const line = renderStatusline({
      configured,
      targets: id ? makeTargets(id).read() : null,
      counts: id ? makeCounts(id).read() : null,
    });
    process.stdout.write(`${line}\n`);
  } catch {
    process.stdout.write("○ ct off\n");
  }
  return 0;
}

function install(argv: string[]): number {
  const { options } = parseFlags(argv);
  const paths = installPaths();
  const settings = readSettings(paths.claudeSettings);
  const command = statuslineCommand();
  const next: StatusLineSetting = { type: "command", command };

  const existing = settings.statusLine;
  if (existing && !isOurStatusline(existing)) {
    console.log(`statusline: ${paths.claudeSettings} already has a statusLine that isn't ours:`);
    console.log(`  ${JSON.stringify(existing)}`);
    console.log("statusline: not overwriting it. To show the indicator alongside your own,");
    console.log("statusline: have your command append the output of:");
    console.log(`  ${command}`);
    return 1;
  }
  if (existing?.command === command) {
    console.log(`statusline: already registered → ${paths.claudeSettings}`);
    return 0;
  }
  if (options["dry-run"] === true) {
    console.log(`statusline: would set statusLine in ${paths.claudeSettings} to`);
    console.log(`  ${JSON.stringify(next)}`);
    return 0;
  }
  mkdirSync(dirname(paths.claudeSettings), { recursive: true });
  writeFileSync(
    paths.claudeSettings,
    `${JSON.stringify({ ...settings, statusLine: next }, null, 2)}\n`,
  );
  console.log(`statusline: registered → ${paths.claudeSettings}`);
  console.log("statusline: restart any open Claude Code session for it to take effect.");
  return 0;
}

function uninstall(): number {
  const paths = installPaths();
  const settings = readSettings(paths.claudeSettings);
  if (!settings.statusLine) {
    console.log("statusline: nothing registered.");
    return 0;
  }
  if (!isOurStatusline(settings.statusLine)) {
    console.log("statusline: the registered statusLine isn't ours; leaving it alone.");
    return 1;
  }
  const { statusLine: _drop, ...rest } = settings;
  writeFileSync(paths.claudeSettings, `${JSON.stringify(rest, null, 2)}\n`);
  console.log(`statusline: removed from ${paths.claudeSettings}`);
  return 0;
}

function status(): number {
  const paths = installPaths();
  const settings = readSettings(paths.claudeSettings);
  console.log(`statusline: settings   ${paths.claudeSettings}`);
  console.log(`statusline: command    ${statuslineCommand()}`);
  const s = settings.statusLine;
  if (!s) {
    console.log("statusline: not registered (run `statusline install`).");
    return 1;
  }
  if (!isOurStatusline(s)) {
    console.log(`statusline: another statusLine is registered: ${JSON.stringify(s)}`);
    return 1;
  }
  console.log("statusline: registered.");
  return 0;
}

export async function runStatusline(argv: string[]): Promise<number> {
  const [sub = "status", ...rest] = argv;
  switch (sub) {
    case "render":
      return render();
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall();
    case "status":
      return status();
    default:
      console.error(
        `statusline: unknown subcommand "${sub}" (render | install | uninstall | status)`,
      );
      return 2;
  }
}
