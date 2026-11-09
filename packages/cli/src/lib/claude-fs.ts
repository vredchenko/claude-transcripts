/**
 * The `.claude/` reader — discovers + reads Claude Code transcripts from the local
 * filesystem. A standalone, host-side module (docs/reference/cli.md): the one legitimately
 * non-webapi input path, reading local files the container can't see. It only
 * READS — derived docs are delivered to the webapi via a sink (see sink.ts).
 *
 * Layout it understands (root defaults to ~/.claude/projects):
 *   <root>/<encoded-cwd>/<sessionId>.jsonl                           the session
 *   <root>/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl  a subagent's own
 *       transcript, with an optional `agent-<agentId>.meta.json` beside it (`agentType`,
 *       `toolUseId`) — the layout current Claude Code writes
 *   <root>/<encoded-cwd>/agent-<agentId>.jsonl                        the same, from
 *       Claude Code versions that kept it beside the sessions; its parent is the
 *       `sessionId` its lines carry
 * Older versions instead wrote subagent lines into the session's own file, marked
 * `isSidechain` — those need nothing found here (see subagents.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default Claude Code transcripts root on this host. */
export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export interface DiscoveredTranscript {
  /** absolute path to the `<id>.jsonl` file */
  path: string;
  /** session id, from the filename */
  sessionId: string;
  /** the encoded-cwd project directory name it lives under */
  project: string;
  /** the session's subagent transcripts, in either on-disk layout (may be empty) */
  subagents: SubagentFile[];
}

/** One subagent's own transcript file. */
export interface SubagentFile {
  /** from the filename — the `agent_id` Claude Code's Subagent* hooks carry */
  agentId: string;
  path: string;
  /** `agent-<agentId>.meta.json`, when Claude Code wrote one */
  metaPath?: string;
}

/** A subagent transcript is named for its agent, never for a session. */
const AGENT_FILE = /^agent-(.+)\.jsonl$/;

/**
 * Discover transcript files under `root`, each with its subagent transcripts. Tolerant:
 * a missing root or unreadable project dir yields fewer results, never throws. Sorted
 * by session id for stable, resumable runs.
 *
 * `agent-*.jsonl` files are never sessions of their own: adopting one would invent a
 * session named after an agent. They are attached to their parent instead.
 */
export async function discoverTranscripts(root: string): Promise<DiscoveredTranscript[]> {
  const out: DiscoveredTranscript[] = [];
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const dir = join(root, proj.name);
    const files = await readdir(dir).catch(() => [] as string[]);
    const sessions: DiscoveredTranscript[] = [];
    const loose: SubagentFile[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const agent = AGENT_FILE.exec(f);
      if (agent?.[1]) {
        loose.push({ agentId: agent[1], path: join(dir, f) });
        continue;
      }
      const sessionId = f.replace(/\.jsonl$/, "");
      sessions.push({
        path: join(dir, f),
        project: proj.name,
        sessionId,
        subagents: await subagentDir(join(dir, sessionId, "subagents")),
      });
    }
    // The flat layout: the only link to the parent session is inside the file.
    for (const a of loose) {
      const parent = await parentSessionOf(a.path);
      const s = sessions.find((x) => x.sessionId === parent);
      if (s && !s.subagents.some((x) => x.agentId === a.agentId)) s.subagents.push(a);
    }
    out.push(...sessions);
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** `<sessionId>/subagents/agent-<id>.jsonl` (+ `.meta.json`); empty when there is none. */
async function subagentDir(dir: string): Promise<SubagentFile[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: SubagentFile[] = [];
  for (const f of files) {
    const agent = AGENT_FILE.exec(f);
    if (!agent?.[1]) continue;
    const meta = `agent-${agent[1]}.meta.json`;
    out.push({
      agentId: agent[1],
      path: join(dir, f),
      ...(files.includes(meta) ? { metaPath: join(dir, meta) } : {}),
    });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** The `sessionId` of the first line that carries one — a loose agent file's parent. */
async function parentSessionOf(path: string): Promise<string | undefined> {
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    try {
      const id = (JSON.parse(line) as { sessionId?: unknown }).sessionId;
      if (typeof id === "string" && id) return id;
    } catch {
      // blank or partial line
    }
  }
  return undefined;
}

/** Read a transcript file's raw JSONL text. */
export function readTranscript(path: string): Promise<string> {
  return readFile(path, "utf8");
}
