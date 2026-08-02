/**
 * `docker compose` for an installed instance.
 *
 * The dev equivalent lives in `scripts/stack.ts`, which resolves everything from the
 * repo. This one works from the instance layout instead: compose files written out of
 * the binary, and the generated instance env as `--env-file`. That's the only
 * difference that matters — a user has no repo, but the compose topology is identical.
 *
 * Backing images come from their canonical public registries (the `upstream` overlay),
 * because a user has no reason to have a registry mirror configured.
 */
import { $ } from "bun";
import { composeFiles } from "./assets";
import type { EnvMap } from "./instance-env";
import type { InstallPaths } from "./paths";

export interface ComposeOptions {
  paths: InstallPaths;
  env: EnvMap;
  /** Include the `app` profile (the combined webapi+SPA image). */
  app?: boolean;
}

function fileArgs(paths: InstallPaths): string[] {
  return composeFiles(paths, true).flatMap((f) => ["-f", f]);
}

/** Run a compose subcommand, inheriting stdio so the user sees pulls and progress. */
export async function compose(opts: ComposeOptions, args: string[]): Promise<void> {
  const profile = opts.app ? ["--profile", "app"] : [];
  await $`docker compose --env-file ${opts.paths.instanceEnv} ${fileArgs(opts.paths)} ${profile} ${args}`.env(
    { ...process.env, ...opts.env },
  );
}

/** Same, but capture output and never throw — for status probing. */
export async function composeQuiet(
  opts: ComposeOptions,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  const profile = opts.app ? ["--profile", "app"] : [];
  try {
    const text =
      await $`docker compose --env-file ${opts.paths.instanceEnv} ${fileArgs(opts.paths)} ${profile} ${args}`
        .env({ ...process.env, ...opts.env })
        .quiet()
        .text();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: String((err as { stderr?: Buffer }).stderr ?? err) };
  }
}

export const composeUp = (o: ComposeOptions) => compose(o, ["up", "-d"]);
export const composeDown = (o: ComposeOptions, volumes = false) =>
  compose(o, volumes ? ["down", "-v"] : ["down"]);
export const composeLogs = (o: ComposeOptions, args: string[] = []) =>
  compose(o, ["logs", ...args]);
export const composePs = (o: ComposeOptions) => compose(o, ["ps"]);

/** Recent log lines for one service — what to show when a health wait times out. */
export async function serviceLogs(o: ComposeOptions, service: string, lines = 30): Promise<string> {
  const res = await composeQuiet(o, ["logs", "--tail", String(lines), service]);
  return res.text.trim();
}

export interface HealthTarget {
  /** Compose service name, used to pull logs if it never comes up. */
  service: string;
  label: string;
  url: string;
  /** Treat these statuses as healthy (some services answer 401 while perfectly up). */
  okStatuses?: number[];
}

/**
 * Wait until a service answers.
 *
 * Deliberately polls the service's own endpoint rather than `docker ps`: a container
 * can be "running" long before it will serve, and provisioning immediately afterwards
 * is exactly what would race.
 */
export async function waitForHealth(
  target: HealthTarget,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; waitedMs: number }> {
  const started = Date.now();
  const ok = new Set(target.okStatuses ?? [200, 204]);
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(target.url, { signal: AbortSignal.timeout(2000) });
      if (ok.has(res.status)) return { ok: true, waitedMs: Date.now() - started };
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  return { ok: false, waitedMs: Date.now() - started };
}

/** The services install waits on, in the order they're needed. */
export function healthTargets(env: EnvMap): HealthTarget[] {
  return [
    {
      service: "couchdb",
      label: "CouchDB",
      url: `http://127.0.0.1:${env.COUCHDB_PORT}/_up`,
    },
    {
      service: "garage",
      label: "Garage",
      // Unauthenticated S3 root answers 403 — that's Garage serving, which is all we need.
      url: `http://127.0.0.1:${env.GARAGE_S3_PORT}/`,
      okStatuses: [200, 403],
    },
    {
      service: "meilisearch",
      label: "Meilisearch",
      url: `http://127.0.0.1:${env.MEILI_PORT}/health`,
    },
  ];
}
