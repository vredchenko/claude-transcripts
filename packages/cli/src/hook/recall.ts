/**
 * `inject-recall-policy`: the session-start primer (docs/design/plugin.md, Part 3).
 *
 * The policy (`recallPrimer`, shared) is pure. What lives here is the one side effect
 * it needs — asking the webapi how many sessions this cwd has — and the two reasons
 * not to ask at all: the policy says off, or this cwd is excluded. Charged on every
 * session start, so the request is short, bounded, and its failure means "no primer",
 * never a delayed or broken session.
 */
import {
  type RecallConfig,
  type RecallCorpusFacts,
  recallPrimer,
  resolveRecall,
} from "@claude-transcripts/shared";
import { resolveWebapiUrl } from "../api/http";
import type { HookContext } from "./runtime";

const FACTS_TIMEOUT_MS = 2000;

/** Does `cwd` match any of the excluded globs? Bun's glob, absolute paths as given. */
export function isExcluded(cwd: string, globs: string[]): boolean {
  for (const g of globs) {
    try {
      if (new Bun.Glob(g).match(cwd)) return true;
    } catch {
      // a bad pattern excludes nothing
    }
  }
  return false;
}

/** How much history is in scope. Null when the webapi can't say in time. */
export async function corpusFacts(
  webapiUrl: string,
  policy: RecallConfig,
  cwd: string,
  hostname: string,
): Promise<RecallCorpusFacts | null> {
  const q = new URLSearchParams({ limit: "1" });
  if (policy.scope === "project") q.set("cwd", cwd);
  else if (policy.scope === "host") q.set("hostname", hostname);
  try {
    const res = await fetch(`${webapiUrl}/api/sessions?${q}`, {
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      totalCount?: number;
      sessions?: { timestamp?: string }[];
    };
    return {
      sessionCount: body.totalCount ?? 0,
      mostRecent: body.sessions?.[0]?.timestamp,
    };
  } catch {
    return null;
  }
}

/** The primer for this session, or null when nothing should be injected. */
export async function buildPrimer(ctx: HookContext): Promise<string | null> {
  const policy = resolveRecall(ctx.config.recall, process.env);
  if (policy.mode === "off" || !policy.primer.onSessionStart) return null;
  if (!ctx.cwd || isExcluded(ctx.cwd, policy.excludeCwdGlobs)) return null;
  let webapi: string;
  try {
    webapi = resolveWebapiUrl();
  } catch {
    return null;
  }
  const facts = await corpusFacts(webapi, policy, ctx.cwd, ctx.hostname);
  if (!facts) return null;
  return recallPrimer(policy, facts, { cwd: ctx.cwd, hostname: ctx.hostname });
}
