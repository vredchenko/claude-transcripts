/**
 * Regenerate the Claude Code hook fixtures under `tests/mock/` with **synthetic**
 * (faker-style) content, so the corpus is shape-faithful but carries no real
 * session history. Dev-only automation (run: `bun run gen:mock`).
 *
 * It walks each fixture in place and, for every string leaf, either KEEPS it (the
 * structural/enum/convention fields that define a payload's shape — event name,
 * tool name, the placeholder session_id/cwd/transcript_path, …) or REPLACES it with
 * deterministic fake data sized to the original (so oversized fixtures stay
 * oversized). Numbers/booleans/null and object structure are preserved verbatim.
 *
 * Deterministic: each file is seeded from its path, so re-running yields stable
 * diffs. Self-contained (no @faker-js/faker dependency) so it needs no install; the
 * generated values are faker-equivalent lorem/paths/commands.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const MOCK_DIR = join(ROOT, "tests/mock");

// ── Field classification ──────────────────────────────────────────────────────

/** String values kept verbatim: they define shape/semantics, not content. */
const KEEP = new Set([
  "hook_event_name",
  "session_id",
  "transcript_path",
  "cwd",
  "tool_name",
  "tool_names",
  "source",
  "permission_mode",
  "agent_type",
  "agent_id",
  "tool_use_id",
  "task_id",
  "error_type",
  "trigger",
  "reason",
  "notification_type",
  "load_reason",
  "memory_type",
  "change_type",
  "mode",
  "scope",
  "level",
  "effort",
  "model",
  "server_name",
  "command_name",
  "session_title",
  "branch",
  "globs",
  "matcher",
  "hook_name",
  "subagent_type",
  "status",
]);

/** Keys whose string value should be faked as a filesystem path. */
const PATHS = new Set([
  "file_path",
  "worktree_path",
  "trigger_file_path",
  "parent_file_path",
  "old_cwd",
  "new_cwd",
]);

/** Keys whose value is large free content — faked as multi-line lorem/code. */
const BIG = new Set([
  "old_string",
  "new_string",
  "tool_output",
  "content",
  "data",
  "expanded_text",
]);

// ── Deterministic RNG (mulberry32) + word pools ───────────────────────────────

function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOREM =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident".split(
    " ",
  );
const SEGMENTS = ["src", "lib", "app", "core", "utils", "modules", "services", "components", "pkg"];
const FILES = [
  "index",
  "handler",
  "config",
  "client",
  "server",
  "types",
  "helpers",
  "main",
  "store",
];
const EXTS = ["ts", "tsx", "js", "json", "md", "txt", "css"];
const CMDS = ["grep -rn", "ls -la", "cat", "rg", "find . -name", "echo", "bun run", "git status"];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function wordsTo(rng: () => number, targetLen: number): string {
  if (targetLen <= 0) return "";
  let out = "";
  while (out.length < targetLen) {
    out += (out ? " " : "") + pick(rng, LOREM);
  }
  return out.slice(0, Math.max(1, targetLen)).trim();
}

function fakePath(rng: () => number): string {
  return `/home/USER/project/${pick(rng, SEGMENTS)}/${pick(rng, FILES)}.${pick(rng, EXTS)}`;
}

function fakeCommand(rng: () => number): string {
  return `${pick(rng, CMDS)} ${pick(rng, LOREM)}`;
}

/** Fake multi-line content sized to `targetLen`, keeping roughly `lines` lines. */
function fakeBlock(rng: () => number, targetLen: number, lines: number): string {
  const rows = Math.max(1, lines);
  const per = Math.max(8, Math.floor(targetLen / rows));
  return Array.from({ length: rows }, () => wordsTo(rng, per)).join("\n");
}

// ── Transform ─────────────────────────────────────────────────────────────────

function fakeString(rng: () => number, key: string, original: string): string {
  if (KEEP.has(key)) return original;
  if (PATHS.has(key)) return fakePath(rng);
  if (key === "command") return fakeCommand(rng);
  const lines = (original.match(/\n/g)?.length ?? 0) + 1;
  if (BIG.has(key) || original.length > 300 || lines > 1) {
    return fakeBlock(rng, original.length, lines);
  }
  return wordsTo(rng, Math.max(3, original.length));
}

function walk(rng: () => number, value: unknown, key: string): unknown {
  if (typeof value === "string") return fakeString(rng, key, value);
  if (Array.isArray(value)) return value.map((v) => walk(rng, v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(rng, v, k);
    }
    return out;
  }
  return value; // number | boolean | null — preserved
}

// ── Run ───────────────────────────────────────────────────────────────────────

const files = [...new Glob("**/*.json").scanSync(MOCK_DIR)].sort();
let changed = 0;
for (const rel of files) {
  const abs = join(MOCK_DIR, rel);
  const original = readFileSync(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    console.warn(`skip (invalid JSON): ${rel}`);
    continue;
  }
  const rng = mulberry32(seedFromString(rel));
  const faked = walk(rng, parsed, "");
  const next = `${JSON.stringify(faked, null, 2)}\n`;
  writeFileSync(abs, next);
  if (next !== original) changed++;
}

console.log(
  `regenerate-mock-fixtures: rewrote ${changed}/${files.length} fixtures under ${relative(ROOT, MOCK_DIR)} with synthetic content`,
);
