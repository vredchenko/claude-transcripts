/**
 * The change follower's trigger for `reconcile-session`: every so often, find the
 * sessions that never fired `SessionEnd` and have gone quiet, and finalise them.
 *
 * It finds them, it doesn't finalise them. The work is the CLI's `reconcile` command —
 * the action's one implementation, named by its `triggers.cli` in the blueprint — run
 * against this webapi with the session ids. The app image ships the CLI (`CT_CLI_BIN`);
 * a checkout runs the workspace's CLI under Bun. Without either, the sweep doesn't start.
 *
 * Candidates come from the session index the follower keeps current, so looking costs
 * nothing: a session is picked when it reads as `incomplete` — exactly what the session
 * list shows under that status. Each sweep takes at most `batchSize`, oldest first. A
 * session the CLI fails on is not retried until the webapi restarts, so one bad
 * session can't make every sweep spawn a process that fails the same way.
 *
 * Off with `system.sessions.reconcile.follower: false`. Best-effort throughout: a
 * failed sweep is logged and the next one runs on schedule.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { followerCliArgs } from "@claude-transcripts/shared";
import { type Config, liveWindowMs, reconcileSettings } from "../config";
import type { AppContext } from "../context";
import { isRealSession, sessionStatus } from "../routes/sessions";
import type { SessionIndexRow } from "./session-index";

/** The action this sweep starts. */
const ACTION = "reconcile-session";

/** How long one CLI run may take before it is killed. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Time from boot to the first sweep: long enough for the session index to warm. */
const FIRST_SWEEP_MS = 60 * 1000;

export interface ReconcileSweep {
  /** Run one sweep now (resolves when it is done; a sweep already running is joined). */
  sweep(): Promise<void>;
  stop(): void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
}

/** Runs the CLI. A seam so the tests don't spawn. */
export type CliRunner = (argv: string[]) => Promise<RunResult>;

/** The sessions to finalise now: incomplete, not failed before, oldest activity first. */
export function staleSessionIds(
  rows: SessionIndexRow[],
  opts: { nowMs: number; windowMs: number; limit: number; skip: Set<string> },
): string[] {
  return rows
    .filter(
      (r) =>
        isRealSession(r.value) &&
        !opts.skip.has(r.key) &&
        sessionStatus(r.value, opts.nowMs, opts.windowMs) === "incomplete",
    )
    .sort((a, b) => (a.value.last || "").localeCompare(b.value.last || ""))
    .slice(0, opts.limit)
    .map((r) => r.key);
}

/** argv that runs the CLI here: the bundled binary, else the workspace's under Bun. */
export function cliArgv(config: Config): string[] | null {
  if (config.webapi.cliBin) return [config.webapi.cliBin];
  const entry = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.tsx");
  return existsSync(entry) ? [process.execPath, "run", entry] : null;
}

/** This webapi's own URL, as the CLI should dial it. */
export function selfUrl(config: Config): string {
  const { host, port } = config.webapi;
  const dial = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${dial.includes(":") ? `[${dial}]` : dial}:${port}`;
}

const spawnCli: CliRunner = (argv) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { stdio: ["ignore", "pipe", "inherit"], cwd: "/" });
    let stdout = "";
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });

interface Outcome {
  sessionId: string;
  result: string;
}

export function startReconcileSweep(
  ctx: AppContext,
  run: CliRunner = spawnCli,
  now: () => number = Date.now,
): ReconcileSweep | null {
  const action = ctx.blueprint?.actions?.find((a) => a.key === ACTION);
  const settings = reconcileSettings(ctx.config);
  if (!action || !followerCliArgs(action, [], "") || !settings.follower) return null;
  const command = action.triggers?.cli;
  const cli = cliArgv(ctx.config);
  if (!cli) {
    console.log("[reconcile] sweep off — no CLI to run (set CT_CLI_BIN)");
    return null;
  }

  const failed = new Set<string>();
  let running: Promise<void> | null = null;

  const once = async (): Promise<void> => {
    if (!ctx.sessionIndex.ready) return;
    const ids = staleSessionIds(ctx.sessionIndex.rows(), {
      nowMs: now(),
      windowMs: liveWindowMs(ctx.config),
      limit: settings.batchSize,
      skip: failed,
    });
    if (!ids.length) return;
    const res = await run([...cli, ...followerCliArgs(action, ids, selfUrl(ctx.config))!]);
    let outcomes: Outcome[] = [];
    try {
      outcomes = (JSON.parse(res.stdout) as { outcomes: Outcome[] }).outcomes ?? [];
    } catch {
      // No report at all: the run itself broke. Hold these back rather than respawn.
      for (const id of ids) failed.add(id);
      console.error(`[reconcile] ${command} exited ${res.code} without a report`);
      return;
    }
    for (const o of outcomes) if (o.result === "failed") failed.add(o.sessionId);
    const done = outcomes.filter((o) => o.result === "reconciled").length;
    console.log(
      `[reconcile] finalised ${done} of ${ids.length} incomplete session(s)` +
        (outcomes.length - done ? `, ${outcomes.length - done} not` : ""),
    );
  };

  const sweep = (): Promise<void> => {
    running ??= once()
      .catch((err) => console.error("[reconcile] sweep failed (continuing):", err))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
  const timer = setInterval(() => void sweep(), settings.intervalMs);
  first.unref?.();
  timer.unref?.();
  return {
    sweep,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
