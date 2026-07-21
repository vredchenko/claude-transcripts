/**
 * `claude-transcripts setup` — install/verify the logging hook + its runtime config.
 *
 *   claude-transcripts setup            # generate config, provision stores, register the hook
 *   claude-transcripts setup --check    # verify an existing installation (read-only)
 *   claude-transcripts setup --no-hook  # config + provision only (no Claude Code registration)
 *   claude-transcripts setup --project  # per-repo registration  (PLACEHOLDER — not yet built)
 *
 * What it does:
 *  1. Build the hook runtime config from `config/` + `.env` and write it to
 *     ~/.config/claude-transcripts/config.json (mode 600) — the file the hook
 *     reads (hooks/scripts/lib/config.ts); nothing else writes it.
 *  2. Provision stores on the configured backend: ensure the CouchDB databases,
 *     probe the Garage bucket (the app never creates buckets). Meilisearch is
 *     intentionally skipped for now.
 *  3. Register the hook with Claude Code. Scope is flexible: we inspect BOTH the
 *     project (`.claude/settings.json`) and global (~/.claude/settings.json) config
 *     to see what's already wired, then act. Only global is implemented today;
 *     per-repo is stubbed (registerProject).
 *
 * Backend-agnostic: endpoints + secrets come from `.env` (Bun auto-loads it), so
 * this points at a localhost stack or an external cluster (e.g. sf0homebox) by
 * changing `.env` only. On this machine, use `--no-hook` for dev so we never
 * register a second logger alongside the running one.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseFlags } from "../lib/args";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HOOK_DIR = join(REPO_ROOT, "hooks");
const HOOK_CONFIG_PATH =
  process.env.CT_HOOK_CONFIG ?? join(homedir(), ".config", "claude-transcripts", "config.json");
const GLOBAL_SETTINGS = join(homedir(), ".claude", "settings.json");
const PROJECT_SETTINGS = join(process.cwd(), ".claude", "settings.json");

interface RepoConfig {
  couchdb: { databases: Record<string, string> };
  s3: { buckets: Record<string, string> };
  features: Record<string, boolean>;
  system: unknown;
}

function loadRepoConfig(): RepoConfig {
  const live = join(REPO_ROOT, "config", "config.json");
  const template = join(REPO_ROOT, "config", "config.template.json");
  return JSON.parse(readFileSync(existsSync(live) ? live : template, "utf8")) as RepoConfig;
}

/** Project the hook runtime config from the repo config + `.env` secrets/endpoints. */
function buildHookConfig(cfg: RepoConfig) {
  const env = process.env;
  const couchUser = env.COUCHDB_USER;
  const couch = {
    url: `http://${env.COUCHDB_HOST ?? "127.0.0.1"}:${env.COUCHDB_PORT ?? "7652"}`,
    databases: cfg.couchdb.databases,
    ...(couchUser ? { auth: `${couchUser}:${env.COUCHDB_PASSWORD ?? ""}` } : {}),
  };
  const blob = env.S3_ENDPOINT
    ? {
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION ?? "garage",
        accessKey: env.S3_ACCESS_KEY,
        secretKey: env.S3_SECRET_KEY,
        buckets: cfg.s3.buckets,
      }
    : undefined;
  return { couch, blob, features: cfg.features, system: cfg.system };
}

function writeHookConfig(config: unknown): void {
  mkdirSync(dirname(HOOK_CONFIG_PATH), { recursive: true });
  writeFileSync(HOOK_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(HOOK_CONFIG_PATH, 0o600);
}

// ── Store provisioning ───────────────────────────────────────────────────────

interface CouchTarget {
  url: string;
  auth?: string;
  databases: Record<string, string>;
}

function couchHeaders(auth?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) h.Authorization = `Basic ${btoa(auth)}`;
  return h;
}

/** Ensure each configured CouchDB database exists (idempotent; 412 = already there). */
async function provisionCouch(t: CouchTarget, dryRun: boolean): Promise<boolean> {
  let ok = true;
  for (const name of Object.values(t.databases)) {
    const url = `${t.url}/${encodeURIComponent(name)}`;
    if (dryRun) {
      console.log(
        `  [check] couch db ${name}: ${(await fetch(url, { headers: couchHeaders(t.auth) })).status}`,
      );
      continue;
    }
    const res = await fetch(url, { method: "PUT", headers: couchHeaders(t.auth) });
    if (res.status === 201) console.log(`  couch db ${name}: created`);
    else if (res.status === 412) console.log(`  couch db ${name}: exists`);
    else {
      ok = false;
      console.error(`  couch db ${name}: FAILED (${res.status} ${res.statusText})`);
    }
  }
  return ok;
}

/**
 * Probe the Garage bucket. The app never *creates* buckets (a Garage bucket + key
 * is an admin/bootstrap step), so setup only checks reachability + reports.
 */
async function probeGarage(blob: ReturnType<typeof buildHookConfig>["blob"]): Promise<void> {
  if (!blob?.endpoint) {
    console.log("  garage: no S3_ENDPOINT — blob storage disabled");
    return;
  }
  const bucket = Object.values(blob.buckets)[0];
  try {
    const { S3Client } = await import("bun");
    const client = new S3Client({
      endpoint: blob.endpoint,
      region: blob.region,
      accessKeyId: blob.accessKey,
      secretAccessKey: blob.secretKey,
    });
    // `.exists()` on a probe key resolves false for a missing key but throws for a
    // missing bucket — enough to tell "bucket present" from "bucket absent".
    await client.file("__claude_transcripts_setup_probe__", { bucket }).exists();
    console.log(`  garage bucket ${bucket}: reachable`);
  } catch (err) {
    console.warn(
      `  garage bucket ${bucket}: NOT reachable/created — create it + a key on the Garage cluster (admin), then set S3_* in .env. (${(err as Error).message})`,
    );
  }
}

// ── Hook registration (Claude Code settings) ─────────────────────────────────

type SettingsHooks = Record<string, Array<{ hooks: Array<{ command?: string }> }>>;

function readSettings(path: string): { hooks?: SettingsHooks } {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Our dispatch command (absolute path — settings.json can't use ${CLAUDE_PLUGIN_ROOT}). */
function dispatchCommand(): string {
  return `bun run ${join(HOOK_DIR, "scripts", "dispatch.ts")}`;
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
    const existing = hooks[event] ?? [];
    if (existing.some((g) => g.hooks.some((h) => (h as { command?: string }).command === cmd)))
      continue;
    hooks[event] = [...existing, ours];
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
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function runSetup(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const check = options.check === true;
  const noHook = options["no-hook"] === true;
  const project = options.project === true;

  console.log(`setup: repo ${REPO_ROOT}`);
  const cfg = loadRepoConfig();
  const hookConfig = buildHookConfig(cfg);
  const couch: CouchTarget = {
    url: hookConfig.couch.url,
    auth: hookConfig.couch.auth,
    databases: hookConfig.couch.databases,
  };
  reportExisting();

  if (check) {
    console.log("setup --check (read-only):");
    console.log(
      `  hook config: ${existsSync(HOOK_CONFIG_PATH) ? "present" : "MISSING"} (${HOOK_CONFIG_PATH})`,
    );
    console.log(`  couch: ${couch.url}`);
    await provisionCouch(couch, true);
    await probeGarage(hookConfig.blob);
    return 0;
  }

  // 1. runtime config
  writeHookConfig(hookConfig);
  console.log(`  wrote hook config → ${HOOK_CONFIG_PATH} (mode 600)`);

  // 2. provision stores (Meilisearch intentionally skipped)
  const couchOk = await provisionCouch(couch, false);
  await probeGarage(hookConfig.blob);

  // 3. register the hook
  if (noHook) {
    console.log("  --no-hook: skipped Claude Code registration (config + stores only)");
  } else if (project) {
    registerProject();
  } else {
    registerGlobal(false);
  }

  console.log("setup: done. Verify with `claude-transcripts setup --check`.");
  return couchOk ? 0 : 1;
}
