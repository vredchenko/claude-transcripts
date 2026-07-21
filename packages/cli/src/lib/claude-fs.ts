/**
 * The `.claude/` reader — discovers + reads Claude Code transcripts from the local
 * filesystem. A standalone, host-side module (docs/cli.md): the one legitimately
 * non-webapi input path, reading local files the container can't see. It only
 * READS — derived docs are delivered to the webapi via a sink (see sink.ts).
 *
 * Layout it understands:
 *   <root>/<encoded-cwd>/<sessionId>.jsonl   (root defaults to ~/.claude/projects)
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
}

/**
 * Discover transcript files under `root`. Tolerant: a missing root or unreadable
 * project dir yields fewer results, never throws. Sorted by session id for stable,
 * resumable runs.
 */
export async function discoverTranscripts(root: string): Promise<DiscoveredTranscript[]> {
  const out: DiscoveredTranscript[] = [];
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const dir = join(root, proj.name);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      out.push({ path: join(dir, f), project: proj.name, sessionId: f.replace(/\.jsonl$/, "") });
    }
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** Read a transcript file's raw JSONL text. */
export function readTranscript(path: string): Promise<string> {
  return readFile(path, "utf8");
}
