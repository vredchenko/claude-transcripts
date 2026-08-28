/**
 * `claude-transcripts install` — get from nothing to "sessions are being recorded".
 *
 *   claude-transcripts install [--yes] [--no-hook] [--no-app] [--port-base N]
 *                              [--meili-key] [--skip-preflight] [--no-prune]
 *
 * A composition, not a monolith: every phase below is also its own command
 * (`stack`, `provision`, `hook install`, `doctor`), so a failure is resumable and an
 * expert can drive one piece. Phases are idempotent — re-running a finished install
 * re-verifies rather than reinstalling — and each failure names the command that
 * resumes from it. See docs/design/installation.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { searchReindex } from "../api/generated";
import { setWebapiUrl } from "../api/http";
import { loadAppConfig } from "../lib/app-config";
import { parseFlags, strOpt } from "../lib/args";
import { linkInstanceEnv, writeAssets, writeVersionStamp } from "../lib/assets";
import { composeUp, healthTargets, serviceLogs, waitForHealth } from "../lib/compose";
import { buildHookConfig, writeHookConfig } from "../lib/hook-config";
import { appImageRepo, pruneAppImages, renderPruneReport } from "../lib/images";
import {
  DEFAULT_PORT_BASE,
  type EnvMap,
  loadOrCreateInstanceEnv,
  portBlock,
} from "../lib/instance-env";
import { installPaths } from "../lib/paths";
import { hasFailures, isPortFree, preflight, renderChecks } from "../lib/preflight";
import { provisionCouch, provisionGarage } from "../lib/provision";
import { DEV_VERSION, VERSION } from "../lib/version";
import { runHook } from "./hook";

function step(n: number, total: number, title: string): void {
  console.log(`\n[${n}/${total}] ${title}`);
}

/** Fail with the single command that resumes from here. */
function abort(message: string, resume: string): number {
  console.error(`\ninstall: ${message}`);
  console.error(`install: fix that, then resume with \`${resume}\``);
  return 1;
}

/**
 * Find a port block where every port is free, starting at `base`.
 *
 * Ports are allocated as one contiguous block because they end up in printed URLs,
 * the services menu and the hook config — a scattered allocation would be impossible
 * to describe.
 */
async function resolvePortBase(base: number, span: number): Promise<number | null> {
  for (let candidate = base; candidate < base + 200; candidate += span) {
    const ports = Object.values(portBlock(candidate)).map(Number);
    const free = await Promise.all(ports.map(isPortFree));
    if (free.every(Boolean)) return candidate;
  }
  return null;
}

/**
 * Compare the running app against the CLI that installed it.
 *
 * Components are versioned in lockstep (ADR 0023), so a mismatch means the image and
 * the CLI disagree about the schema, the API contract, or both — and that failure is
 * silent by nature: everything starts, and only some later read behaves oddly. A
 * deliberate pin is legitimate, so this warns rather than fails.
 */
async function warnOnVersionSkew(env: EnvMap): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${env.WEBAPI_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { version?: string };
    const running = body.version ?? "unknown";
    // A `main` image reports "<last release>+<sha>", which never equals a release
    // version — so only compare when the CLI itself is a release.
    if (VERSION !== DEV_VERSION && running !== VERSION) {
      console.log(`  ! app image reports ${running}, but this CLI is ${VERSION}`);
      console.log("    they are versioned in lockstep — pin APP_TAG in the instance env");
    } else {
      console.log(`  app image ${running} (tag ${env.APP_TAG})`);
    }
  } catch {
    // The health check already passed; this is extra information, not a gate.
  }
}

/**
 * Create the search indexes and fill them from CouchDB.
 *
 * Best-effort by design: search is an optional feature, so an engine that's off or
 * unreachable must not fail an install that is otherwise fine. It says what happened
 * and names the command to retry with.
 */
async function setUpSearch(webapiUrl: string): Promise<void> {
  // Point the generated client at THIS instance. It otherwise resolves the default
  // 127.0.0.1:7650, which is right only when the instance happens to use the default
  // port — so on any other port the search step failed with a bare ECONNREFUSED while
  // the install it belonged to reported success.
  setWebapiUrl(webapiUrl);
  try {
    const res = await searchReindex();
    if (!res.enabled) {
      console.log("  – search is off (features.meilisearch false, or MEILI_HOST unset)");
      return;
    }
    console.log(`  ✓ indexed ${res.sessions.indexed} session(s), ${res.turns.indexed} turn(s)`);
    if (res.failures.length) {
      for (const f of res.failures.slice(0, 3)) console.log(`  ! ${f}`);
    }
  } catch (err) {
    console.log(`  – search not indexed (${(err as Error).message})`);
    console.log("    retry with `claude-transcripts reindex` once Meilisearch is reachable.");
  }
}

export async function runInstall(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const noHook = options["no-hook"] === true;
  const noApp = options["no-app"] === true;
  const meiliKey = options["meili-key"] === true;
  const noPrune = options["no-prune"] === true;
  const portBaseOpt = strOpt(options, "port-base");
  const paths = installPaths();
  // Read before loadOrCreateInstanceEnv rewrites it, so a moved pin can be reported.
  const priorAppTag = existsSync(paths.instanceEnv)
    ? /^APP_TAG=(\S+)\s*$/m.exec(readFileSync(paths.instanceEnv, "utf8"))?.[1]
    : undefined;
  const TOTAL = 8;

  console.log(`claude-transcripts install (${VERSION})`);
  console.log(`  config  ${paths.configDir}`);
  console.log(`  data    ${paths.dataDir}`);

  // ── 1. Preflight — nothing is written until this passes ────────────────────
  step(1, TOTAL, "Preflight");
  const requestedBase = portBaseOpt ? Number(portBaseOpt) : DEFAULT_PORT_BASE;
  const span = Object.keys(portBlock(requestedBase)).length;
  const checks = await preflight({
    ports: Object.values(portBlock(requestedBase)).map(Number),
    claudeSettings: paths.claudeSettings,
    skipDocker: noApp && options["skip-preflight"] === true,
  });
  console.log(renderChecks(checks));
  if (hasFailures(checks) && options["skip-preflight"] !== true) {
    return abort("preflight failed — nothing was changed.", "claude-transcripts install");
  }

  // A busy port block is recoverable: shift the whole block rather than failing.
  let portBase = requestedBase;
  if (checks.some((c) => c.name === "ports" && c.status === "warn")) {
    const found = await resolvePortBase(requestedBase, span);
    if (found === null) {
      return abort("could not find a free port block.", "claude-transcripts install --port-base N");
    }
    if (found !== requestedBase) console.log(`  → ports busy; using ${found}–${found + span - 1}`);
    portBase = found;
  }

  // ── 2. Configure ──────────────────────────────────────────────────────────
  step(2, TOTAL, "Configuration");
  const firstRun = !existsSync(paths.instanceEnv);
  let env: EnvMap = loadOrCreateInstanceEnv(paths.instanceEnv, {
    portBase,
    // Lockstep versioning (ADR 0023) means the CLI and the app image have to move
    // together. A released CLI pins its exact version; an unreleased one tracks
    // `main`, because `latest` is the newest *release* and would pair a dev CLI with
    // an older app — which is how an install ended up running schema v5 against a
    // v7 CLI.
    appTag: VERSION === DEV_VERSION ? "main" : VERSION,
    meiliMasterKey: meiliKey,
  });
  console.log(`  ${firstRun ? "generated" : "reused"} ${paths.instanceEnv}`);
  if (!firstRun && priorAppTag && priorAppTag !== env.APP_TAG) {
    console.log(`  app image pin ${priorAppTag} → ${env.APP_TAG} (follows this CLI)`);
  }
  const written = writeAssets(paths);
  // The app service reads `env_file: ../.env` relative to the compose file.
  linkInstanceEnv(paths);
  writeVersionStamp(paths, VERSION);
  console.log(
    `  assets: ${written.filter((w) => w.changed).length} written, ${written.length} total`,
  );

  // ── 3. Backing services ───────────────────────────────────────────────────
  step(3, TOTAL, "Backing services");
  try {
    await composeUp({ paths, env });
  } catch (err) {
    return abort(`docker compose failed: ${(err as Error).message}`, "claude-transcripts stack up");
  }
  for (const target of healthTargets(env)) {
    const { ok, waitedMs } = await waitForHealth(target);
    if (!ok) {
      console.error(`\n  ${target.label} never became healthy. Recent logs:`);
      console.error(await serviceLogs({ paths, env }, target.service));
      // The stack is deliberately left running — tearing it down destroys the evidence.
      return abort(`${target.label} did not come up.`, "claude-transcripts stack logs");
    }
    console.log(`  ✓ ${target.label} (${(waitedMs / 1000).toFixed(1)}s)`);
  }

  // ── 4. Provision stores ───────────────────────────────────────────────────
  step(4, TOTAL, "Provisioning stores");
  const app = loadAppConfig();
  try {
    for (const s of await provisionCouch(env, Object.values(app.couchdb.databases))) {
      console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
      if (!s.ok) return abort("CouchDB provisioning failed.", "claude-transcripts provision");
    }
    const bucket = app.s3.buckets.sessions ?? "claude-transcripts-sessions";
    const garage = await provisionGarage(env, bucket, paths.instanceEnv);
    for (const s of garage.steps) console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
    // Garage minted the S3 credentials just now — everything downstream needs the
    // updated env, which is exactly why the app starts after this phase.
    env = garage.env;
  } catch (err) {
    return abort(`provisioning failed: ${(err as Error).message}`, "claude-transcripts provision");
  }

  // ── 5. Application ────────────────────────────────────────────────────────
  step(5, TOTAL, "Application");
  if (noApp) {
    console.log("  --no-app: skipped (run the webapi yourself)");
  } else {
    try {
      await composeUp({ paths, env, app: true });
    } catch (err) {
      return abort(
        `app container failed: ${(err as Error).message}`,
        "claude-transcripts stack up --app",
      );
    }
    const health = await waitForHealth({
      service: "app",
      label: "webapi",
      url: `http://127.0.0.1:${env.WEBAPI_PORT}/health`,
    });
    if (!health.ok) {
      console.error(await serviceLogs({ paths, env, app: true }, "app"));
      return abort("the webapi did not become healthy.", "claude-transcripts stack logs --app");
    }
    console.log(`  ✓ webapi (${(health.waitedMs / 1000).toFixed(1)}s)`);
    await warnOnVersionSkew(env);

    // Reclaim the images this upgrade superseded — last in the phase, and only once
    // the new one has served a health check. Pruning any earlier would spend the
    // rollback target to make room for an image not yet known to work.
    if (noPrune) {
      console.log("  --no-prune: keeping superseded app images");
    } else {
      const repo = appImageRepo(env);
      const report = await pruneAppImages({
        repo,
        keepTags: [env.APP_TAG ?? "", priorAppTag ?? ""],
      });
      console.log(renderPruneReport(report, repo));
    }
  }

  // ── 6. Hook ───────────────────────────────────────────────────────────────
  step(6, TOTAL, "Claude Code hook");
  writeHookConfig(paths.hookConfig, buildHookConfig(app, env));
  console.log(`  wrote ${paths.hookConfig} (0600)`);
  if (noHook) {
    console.log("  --no-hook: skipped registration");
  } else {
    await runHook(["install"]);
  }

  // ── 7. Search ─────────────────────────────────────────────────────────────
  // Through the webapi, and only once it's up: the indexes and their settings are the
  // webapi's to own (ADR 0016), and `reindex` both creates them and fills them.
  //
  // Filling them matters on an install that isn't starting from nothing — a restored
  // bundle, a reused CouchDB volume, an upgrade that renamed the indexes. The change
  // follower starts at *now*, so anything already in CouchDB would otherwise stay
  // unfindable until someone discovered `reindex` for themselves.
  step(7, TOTAL, "Search");
  if (noApp) {
    console.log("  --no-app: skipped (needs the webapi; run `claude-transcripts reindex` later)");
  } else {
    await setUpSearch(`http://127.0.0.1:${env.WEBAPI_PORT}`);
  }

  // ── 8. Verify ─────────────────────────────────────────────────────────────
  step(8, TOTAL, "Verify");
  // Name the URL: `doctor` defaults to 127.0.0.1:7650 like every other command, so on
  // an instance with a different port the bare invocation reports a dead webapi.
  const doctorCmd = noApp
    ? "claude-transcripts doctor"
    : `claude-transcripts doctor --webapi http://127.0.0.1:${env.WEBAPI_PORT}`;
  console.log(`  run \`${doctorCmd}\` to exercise the whole write→read→search path.`);

  console.log("\ninstall: done.");
  console.log(`  UI       http://127.0.0.1:${env.WEBAPI_PORT}/app`);
  console.log(`  API      http://127.0.0.1:${env.WEBAPI_PORT}/api/docs`);
  console.log(`  data     docker volumes (survive uninstall unless --purge)`);
  console.log("  remove   claude-transcripts uninstall");
  return 0;
}
