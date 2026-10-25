/**
 * The running Claude Code's hook spec: which version is this, and what does that
 * version's hook surface look like (ADR 0025)?
 *
 * The version comes from `claude --version` — documented, and ~50 ms. A hook payload
 * carries no version, so asking the binary is the one reliable answer. Claude Code
 * points `CLAUDE_CODE_EXECPATH` at the binary it is running, which is the right one to
 * ask when several are installed; `claude` on PATH is the fallback.
 *
 * The spec comes from the matching `@anthropic-ai/claude-agent-sdk` release on npm
 * (see `@claude-transcripts/shared`'s `claude-code-spec`). The spec this build was
 * verified against ships inside it; any other version is fetched once — checked against
 * the registry's sha512 — and cached under the data dir. Published npm versions are
 * immutable, so a cached spec never goes stale.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type HookSpec, parseSdkHookSpec, VERIFIED_HOOK_SPEC } from "@claude-transcripts/shared";
import { installPaths } from "./paths";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const REGISTRY =
  process.env.NPM_CONFIG_REGISTRY?.replace(/\/$/, "") ?? "https://registry.npmjs.org";

/** `2.1.310` from `2.1.310 (Claude Code)`, or null when Claude Code can't be asked. */
export function claudeCodeVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.CLAUDE_CODE_EXECPATH, "claude"].filter(Boolean) as string[];
  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000, cwd: "/" });
      const m = /^(\d+\.\d+\.\d+)/.exec(res.stdout?.trim() ?? "");
      if (m) return m[1]!;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function cacheDir(): string {
  return join(installPaths().dataDir, "claude-code-specs");
}

function cacheFile(version: string): string {
  return join(cacheDir(), `${version}.json`);
}

/** The spec for `version` without touching the network: the bundled one, or the cache. */
export function knownHookSpec(version: string): HookSpec | null {
  if (version === VERIFIED_HOOK_SPEC.claudeCode) return VERIFIED_HOOK_SPEC;
  try {
    const file = cacheFile(version);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as HookSpec) : null;
  } catch {
    return null;
  }
}

export function cacheHookSpec(spec: HookSpec): void {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(cacheFile(spec.claudeCode), `${JSON.stringify(spec, null, 2)}\n`);
}

interface SdkRelease {
  version: string;
  claudeCodeVersion?: string;
  dist: { tarball: string; integrity?: string };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Every SDK release, oldest first, and the one `latest` points at. */
async function sdkReleases(): Promise<{ releases: SdkRelease[]; latest: string }> {
  const doc = await getJson<{
    versions: Record<string, SdkRelease>;
    "dist-tags": Record<string, string>;
    time: Record<string, string>;
  }>(`${REGISTRY}/${SDK_PACKAGE.replace("/", "%2f")}`);
  const releases = Object.values(doc.versions).sort((a, b) =>
    (doc.time[a.version] ?? "").localeCompare(doc.time[b.version] ?? ""),
  );
  return { releases, latest: doc["dist-tags"].latest ?? "" };
}

/** The Claude Code version the SDK's `latest` release was cut for. */
export async function latestClaudeCodeVersion(): Promise<string> {
  const { releases, latest } = await sdkReleases();
  const cc = releases.find((r) => r.version === latest)?.claudeCodeVersion;
  if (!cc) throw new Error(`${SDK_PACKAGE}@${latest} names no claudeCodeVersion`);
  return cc;
}

/** One file out of a gzipped npm tarball (ustar: 512-byte headers, size in octal). */
function tarEntry(tgz: Uint8Array, path: string): string | null {
  const tar = gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar
      .subarray(off, off + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) return null;
    const size = Number.parseInt(
      tar
        .subarray(off + 124, off + 136)
        .toString("utf8")
        .trim(),
      8,
    );
    const body = off + 512;
    if (name === path) return tar.subarray(body, body + size).toString("utf8");
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Fetch the hook spec for Claude Code `version` from npm. Throws when no SDK release
 * names that version, when the tarball fails its integrity check, or when its
 * `sdk.d.ts` can't be read — never returns a guess.
 */
export async function fetchHookSpec(version: string): Promise<HookSpec> {
  const { releases } = await sdkReleases();
  const release = releases.filter((r) => r.claudeCodeVersion === version).at(-1);
  if (!release) throw new Error(`no ${SDK_PACKAGE} release names Claude Code ${version}`);

  const res = await fetch(release.dist.tarball);
  if (!res.ok) throw new Error(`GET ${release.dist.tarball} → HTTP ${res.status}`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const integrity = release.dist.integrity;
  if (integrity?.startsWith("sha512-")) {
    const got = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
    if (got !== integrity) throw new Error(`${SDK_PACKAGE}@${release.version}: integrity mismatch`);
  }
  const dts = tarEntry(tgz, "package/sdk.d.ts");
  if (!dts) throw new Error(`${SDK_PACKAGE}@${release.version} has no sdk.d.ts`);
  return parseSdkHookSpec(dts, { claudeCode: version, sdk: release.version });
}
