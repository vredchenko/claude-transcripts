/**
 * The recall policy: when a live session should reach for its own history unprompted
 * (docs/design/plugin.md, Part 3).
 *
 * A skill's description only decides whether Claude *loads* the skill; it does not make
 * Claude think of looking. So the rules live in config, are resolved here, and are
 * injected once at session start together with the one local fact that turns a rule
 * into a trigger: that this directory has recorded sessions.
 *
 * Precedence, stated once: per-user plugin `userConfig` (arrives as
 * `CLAUDE_PLUGIN_OPTION_*` env vars) → the deployment's `config` `recall` section →
 * {@link DEFAULT_RECALL}. Pure and isomorphic — the hook and the webui both read it.
 */
import type { EnvLike } from "./types";

export type RecallMode = "off" | "suggest" | "auto";
export type RecallScope = "project" | "host" | "all";

export interface RecallConfig {
  /** `off`: never; `suggest`: propose a search and let the user confirm; `auto`: just search. */
  mode: RecallMode;
  /** Which sessions count: this project's cwd, this host, or every recorded session. */
  scope: RecallScope;
  maxResults: number;
  maxSnippetChars: number;
  triggers: {
    /** "did we…", "why is this…", "what did we decide…" */
    priorWorkQuestion: boolean;
    /** an error that looks like one seen in past sessions */
    repeatedError: boolean;
    /** about to redo something that looks like prior work here */
    beforeRederiving: boolean;
  };
  /** cwd globs never recalled from — and never primed in. */
  excludeCwdGlobs: string[];
  primer: { onSessionStart: boolean; maxTokens: number };
}

export const RECALL_MODES: readonly RecallMode[] = ["off", "suggest", "auto"];
export const RECALL_SCOPES: readonly RecallScope[] = ["project", "host", "all"];

/**
 * Conservative defaults: on, but scoped to this project — cross-project recall reads
 * other work's content back into a session, which is what makes `secretsMasking`
 * matter, and that flag is still off (plugin.md, "Privacy").
 */
export const DEFAULT_RECALL: RecallConfig = {
  mode: "auto",
  scope: "project",
  maxResults: 5,
  maxSnippetChars: 400,
  triggers: { priorWorkQuestion: true, repeatedError: true, beforeRederiving: true },
  excludeCwdGlobs: [],
  primer: { onSessionStart: true, maxTokens: 200 },
};

/** Plugin `userConfig` keys, as Claude Code exports them to hook processes. */
export const RECALL_ENV = {
  mode: "CLAUDE_PLUGIN_OPTION_RECALL_MODE",
  scope: "CLAUDE_PLUGIN_OPTION_RECALL_SCOPE",
  maxResults: "CLAUDE_PLUGIN_OPTION_MAX_RESULTS",
} as const;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Resolve the policy: env (per user) over config (per deployment) over defaults. */
export function resolveRecall(
  fromConfig: DeepPartial<RecallConfig> | undefined,
  env: EnvLike = {},
): RecallConfig {
  const c = fromConfig ?? {};
  const merged: RecallConfig = {
    ...DEFAULT_RECALL,
    ...stripUndefined(c),
    triggers: { ...DEFAULT_RECALL.triggers, ...stripUndefined(c.triggers ?? {}) },
    primer: { ...DEFAULT_RECALL.primer, ...stripUndefined(c.primer ?? {}) },
    excludeCwdGlobs: c.excludeCwdGlobs ?? DEFAULT_RECALL.excludeCwdGlobs,
  } as RecallConfig;

  const mode = env[RECALL_ENV.mode];
  if (mode && (RECALL_MODES as string[]).includes(mode)) merged.mode = mode as RecallMode;
  const scope = env[RECALL_ENV.scope];
  if (scope && (RECALL_SCOPES as string[]).includes(scope)) merged.scope = scope as RecallScope;
  const max = Number(env[RECALL_ENV.maxResults]);
  if (Number.isInteger(max) && max > 0) merged.maxResults = max;
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as any)[k] = v;
  return out;
}

/** What the primer needs to know about the corpus for this session's cwd. */
export interface RecallCorpusFacts {
  /** Sessions recorded in scope (this cwd, this host, or everywhere). */
  sessionCount: number;
  /** ISO timestamp of the most recent one, if any. */
  mostRecent?: string;
}

/** The scope flag the skill should pass to `claude-transcripts search`. */
export function scopeFlag(scope: RecallScope, cwd: string, hostname: string): string {
  switch (scope) {
    case "project":
      return `--cwd "${cwd}"`;
    case "host":
      return `--hostname "${hostname}"`;
    default:
      return "";
  }
}

function daysAgo(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const d = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(d)) return "";
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/**
 * The session-start primer, or null when it must not be sent: mode `off`, primer
 * disabled, or nothing recorded in scope — an empty corpus must not pay for a primer
 * telling Claude to search it. Kept well under `primer.maxTokens` (~200).
 */
export function recallPrimer(
  policy: RecallConfig,
  facts: RecallCorpusFacts,
  where: { cwd: string; hostname: string },
  now = Date.now(),
): string | null {
  if (policy.mode === "off" || !policy.primer.onSessionStart) return null;
  if (facts.sessionCount <= 0) return null;

  const scopeWord = { project: "this project", host: "this host", all: "all projects" }[
    policy.scope
  ];
  const recent = daysAgo(facts.mostRecent, now);
  const flag = scopeFlag(policy.scope, where.cwd, where.hostname);
  const when: string[] = [];
  if (policy.triggers.priorWorkQuestion)
    when.push("a question about why existing code or a decision is the way it is");
  if (policy.triggers.repeatedError) when.push("an error that looks familiar");
  if (policy.triggers.beforeRederiving)
    when.push("re-deriving something that looks like prior work here");

  const action =
    policy.mode === "auto"
      ? "search history first"
      : "offer to search history, and search if the user agrees";

  return [
    `Session history for ${scopeWord} is available via \`claude-transcripts search "<query>" ${flag} --json --limit ${policy.maxResults}\`.`,
    `${facts.sessionCount} recorded session${facts.sessionCount === 1 ? "" : "s"} in scope${recent ? `, most recent ${recent}` : ""}.`,
    when.length ? `Before answering ${joinOr(when)}, ${action}.` : "",
    `Cite the session id and date. Snippets only, never a whole transcript; max ${policy.maxResults} results. See the \`recall\` skill.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
