/**
 * Work that must outlive the hook: the end-of-session transcript upload (#217).
 *
 * `SessionEnd` is synchronous so the upload is not reaped mid-flight — but Claude Code
 * caps its exit budget regardless of the registered timeout (60s at most, 1.5s at
 * worst; `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides it) and cancels the hook
 * when it runs out. A multi-megabyte transcript loses that race on a long session, so
 * the upload is handed to a child that is not the hook's to cancel.
 *
 * `detached` puts the child in its own session (setsid on POSIX), out of the hook's
 * process group, so a signal to that group or the terminal's hangup does not reach it.
 * `stdio: "ignore"` matters as much: an inherited stdout or stderr would keep Claude
 * Code's pipe open, and it would wait on the child exactly as it waited on the upload.
 */
import { spawn } from "node:child_process";

/**
 * argv that invokes *this* CLI — the compiled binary, or `bun run <entry>` from a
 * checkout (where `process.execPath` is `bun` itself).
 */
export function cliArgv(): string[] {
  const exec = process.execPath;
  if (!/\/bun$/.test(exec)) return [exec];
  return [exec, "run", Bun.main];
}

/** Start `argv` detached from this process and return without waiting. False if it could not start. */
export function spawnDetached(argv: string[]): boolean {
  const [cmd, ...args] = argv;
  if (!cmd) return false;
  try {
    // `cd /` for the same reason the hook command has it: a session directory that was
    // deleted mid-session is not a cwd a process can start in (#171).
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", cwd: "/" });
    // A missing binary is reported asynchronously; without a listener it would throw.
    child.on("error", () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}

/** The command that uploads one session's transcript — see `hook upload`. */
export function uploadArgv(sessionId: string, transcriptPath: string): string[] {
  return [...cliArgv(), "hook", "upload", "--session", sessionId, "--transcript", transcriptPath];
}
