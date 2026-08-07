#!/usr/bin/env bun
/**
 * The plugin's entry point: hand the hook payload to the installed CLI.
 *
 * This used to be a second, parallel implementation of the writer — its own handlers,
 * its own CouchDB and S3 clients, its own copy of `sumTranscriptTokens` and the
 * chunking helpers kept **byte-identical** with `@claude-transcripts/shared` by hand.
 * That existed for one reason: a plugin directory can't resolve the workspace, so it
 * couldn't import the real code.
 *
 * Once `claude-transcripts hook run` became the registered hook, the reason expired —
 * an installed binary resolves everything itself. Keeping the copy only preserved the
 * drift risk that comes with any "keep these two files identical" rule, so the plugin
 * now delegates and there is exactly one writer.
 *
 * The one rule this file inherits: **never block a session.** A missing CLI, a broken
 * install, a crash inside the delegate — all of it exits 0. Claude Code treats a
 * non-zero hook as a problem, and a logging tool must never become one.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where to look for the binary.
 *
 * PATH first, since that's the normal case. The explicit fallbacks cover the installer's
 * own target (`~/.local/bin`, which isn't on PATH in every shell — notably a desktop
 * launcher's environment, which is where a hook often runs) and `CT_HOME` for a
 * relocated instance.
 */
function candidates(): string[] {
  const ctHome = process.env.CT_HOME;
  const out = ["claude-transcripts"];
  if (ctHome) out.push(join(ctHome, "bin", "claude-transcripts"));
  out.push(join(homedir(), ".local", "bin", "claude-transcripts"));
  return out;
}

function resolveCli(): string | null {
  const [onPath, ...fallbacks] = candidates();
  for (const p of fallbacks) if (existsSync(p)) return p;
  // Bare name last: spawn resolves it against PATH, and we can't stat it here.
  return onPath ?? null;
}

async function main(): Promise<void> {
  const payload = await Bun.stdin.text();
  const cli = resolveCli();
  if (!cli) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    const child = spawn(cli, ["hook", "run"], { stdio: ["pipe", "inherit", "inherit"] });

    child.on("error", (err) => {
      // Almost always "not installed". Say so once, on stderr, and carry on — the
      // session must not care.
      console.error(
        `[claude-transcripts] hook skipped: couldn't run \`${cli}\` (${err.message}). ` +
          "Install the CLI, or register the hook directly with `claude-transcripts hook install`.",
      );
      finish();
    });
    child.on("close", finish);

    child.stdin.on("error", finish); // the child may exit before we finish writing
    child.stdin.end(payload);
  });
}

try {
  await main();
} catch (err) {
  console.error("[claude-transcripts] hook skipped:", err);
}
process.exit(0);
