/**
 * Hook runtime for the installed CLI.
 *
 * A user install has neither Bun nor a repo checkout, so the hook can't be
 * `bun run <repo>/hooks/scripts/dispatch.ts` — the registered command is the CLI
 * binary itself (`claude-transcripts hook run`, see installation.md). This module is
 * that hook: it reads the same runtime config the standalone plugin reads, so both
 * forms behave identically and an install can move between them.
 *
 * The one rule that overrides everything else: **the hook must never block a session.**
 * Every external call is wrapped, every failure is swallowed, and the process always
 * exits 0. Losing a session's history is bad; wedging someone's Claude Code is worse.
 */
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { S3Client } from "bun";
import {
  fanOutBlob,
  fanOutCouch,
  type MirrorTarget,
  makeMirrorBlob,
  makeMirrorCouch,
} from "./mirror";

export interface HookConfig {
  couch: { url: string; databases: Record<string, string>; auth?: string };
  blob?: {
    endpoint: string;
    region: string;
    accessKey?: string;
    secretKey?: string;
    buckets: Record<string, string>;
  };
  /**
   * Additional instances that receive the same writes, reached through their webapi
   * (see {@link MirrorTarget}). Absent or empty writes to the local stores only,
   * which is what every config written before mirrors existed says.
   */
  mirrors?: MirrorTarget[];
  features: Record<string, boolean>;
  system: { logging: { chunk: { maxEntriesPerChunk: number; flushIntervalMs: number } } };
}

/** Load the runtime config, or null to silently do nothing (no install → no logging). */
export function loadHookConfig(path: string): HookConfig | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HookConfig;
  } catch {
    return null;
  }
}

// ── Stores ───────────────────────────────────────────────────────────────────

export interface CouchClient {
  postDoc(db: string, doc: object): Promise<void>;
  putDoc(db: string, id: string, doc: object, timeoutMs?: number): Promise<void>;
}

/**
 * CouchDB over plain HTTP with a short timeout — a slow store must not stall a session.
 *
 * `onWrite` hears whether each write landed. It exists for the statusline: "recording"
 * has to mean a store that recently accepted a doc, not merely a config file that
 * names one ({@link TargetsStore}).
 */
function makeDirectCouch(config: HookConfig, onWrite?: (ok: boolean) => void): CouchClient {
  const root = config.couch.url;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.couch.auth) headers.Authorization = `Basic ${btoa(config.couch.auth)}`;

  return {
    async postDoc(db, doc) {
      try {
        const res = await fetch(`${root}/${db}`, {
          method: "POST",
          headers,
          body: JSON.stringify(doc),
          signal: AbortSignal.timeout(5000),
        });
        onWrite?.(res.ok);
      } catch {
        onWrite?.(false);
      }
    },
    async putDoc(db, id, doc, timeoutMs = 5000) {
      try {
        const res = await fetch(`${root}/${db}/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(doc),
          signal: AbortSignal.timeout(timeoutMs),
        });
        onWrite?.(res.ok);
      } catch {
        onWrite?.(false);
      }
    },
  };
}

/**
 * The hook's CouchDB writer: this machine's store, plus any configured mirrors.
 *
 * The fan-out lives here rather than in the handlers on purpose — a composite that
 * satisfies {@link CouchClient} means "write to two places" is a config fact, not a
 * thing every handler has to remember to do.
 */
export function makeCouch(config: HookConfig, onWrite?: (ok: boolean) => void): CouchClient {
  const mirrors = config.mirrors ?? [];
  return fanOutCouch([makeDirectCouch(config, onWrite), ...mirrors.map((m) => makeMirrorCouch(m))]);
}

export interface BlobClient {
  enabled: boolean;
  put(bucket: string, key: string, data: Buffer | string, contentType: string): Promise<void>;
}

function makeDirectBlob(config: HookConfig): BlobClient {
  const cfg = config.blob;
  const s3 = cfg?.accessKey
    ? new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secretKey,
      })
    : null;
  return {
    enabled: Boolean(s3),
    async put(bucket, key, data, contentType) {
      if (!s3) return;
      try {
        await s3.write(key, data, { bucket, type: contentType });
      } catch {
        // non-fatal
      }
    },
  };
}

/** The hook's blob writer: local S3, plus any configured mirrors. */
export function makeBlob(config: HookConfig): BlobClient {
  const mirrors = config.mirrors ?? [];
  return fanOutBlob([makeDirectBlob(config), ...mirrors.map((m) => makeMirrorBlob(m))]);
}

// ── Per-session state (survives the many short-lived hook processes) ──────────

export interface Counts {
  events: number;
  prompts: number;
  errors: number;
  tools: Record<string, number>;
}

const emptyCounts = (): Counts => ({ events: 0, prompts: 0, errors: 0, tools: {} });

export interface CountsStore {
  read(): Counts;
  reset(): void;
  inc(key: "events" | "prompts" | "errors"): void;
  incTool(tool: string): void;
  clear(): void;
}

export function makeCounts(sessionId: string): CountsStore {
  const file = `/tmp/claude-transcripts-${sessionId}.counts`;
  const read = (): Counts => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Counts;
    } catch {
      return emptyCounts();
    }
  };
  const write = (c: Counts): void => {
    try {
      writeFileSync(file, JSON.stringify(c));
    } catch {
      // non-fatal
    }
  };
  return {
    read,
    reset: () => write(emptyCounts()),
    inc(key) {
      const c = read();
      c[key]++;
      write(c);
    },
    incTool(tool) {
      const c = read();
      c.tools[tool] = (c.tools[tool] ?? 0) + 1;
      write(c);
    },
    clear() {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

/**
 * Where this session is being recorded, resolved once at session start — the "where"
 * half of the statusline, next to the counters' "how much". Credentials never go in
 * here: it is read by a renderer that runs on every statusline refresh, and the line it
 * prints lands in a terminal.
 */
export interface Targets {
  /** CouchDB base URL with any userinfo stripped. */
  couchUrl: string;
  sessionsDb: string;
  /** S3 bucket, if blob upload is configured. */
  bucket?: string;
  /** The webapi this machine's CLI resolves to — where the deep link points. */
  webapiUrl?: string;
  /** Feature flags that were on when the session started. */
  features: string[];
  /** Mirrors this machine also reports into (URLs only). */
  mirrors: string[];
  /** Epoch ms of the last write CouchDB accepted; 0 until one lands. */
  lastWriteMs: number;
  /** Epoch ms of the last write that failed after the last success; 0 if none. */
  lastFailureMs: number;
}

export interface TargetsStore {
  read(): Targets | null;
  write(t: Targets): void;
  /** Stamp the outcome of one CouchDB write. */
  markWrite(ok: boolean): void;
  clear(): void;
}

export function targetsFile(sessionId: string): string {
  return `/tmp/claude-transcripts-${sessionId}.targets`;
}

export function makeTargets(sessionId: string): TargetsStore {
  const file = targetsFile(sessionId);
  const read = (): Targets | null => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Targets;
    } catch {
      return null;
    }
  };
  const write = (t: Targets): void => {
    try {
      writeFileSync(file, JSON.stringify(t));
    } catch {
      // non-fatal
    }
  };
  return {
    read,
    write,
    markWrite(ok) {
      const t = read();
      if (!t) return; // no session-start seed → nothing to annotate
      if (ok) {
        t.lastWriteMs = Date.now();
        t.lastFailureMs = 0;
      } else {
        t.lastFailureMs = Date.now();
      }
      write(t);
    },
    clear() {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

/** Drop the `user:pass@` from a URL so it can be shown. Non-URLs pass through. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** The resolved targets for a config, before any write has happened. */
export function resolveTargets(config: HookConfig, webapiUrl?: string): Targets {
  return {
    couchUrl: redactUrl(config.couch.url),
    sessionsDb: config.couch.databases.sessions ?? DEFAULT_SESSIONS_DB,
    bucket: config.blob?.accessKey ? config.blob.buckets.sessions : undefined,
    webapiUrl,
    features: Object.entries(config.features ?? {})
      .filter(([, on]) => on)
      .map(([k]) => k),
    mirrors: (config.mirrors ?? []).map((m) => redactUrl(m.url)),
    lastWriteMs: 0,
    lastFailureMs: 0,
  };
}

export interface ChunkState {
  offset: number;
  lastFlushMs: number;
}

const STALE_LOCK_MS = 30_000;

export interface ChunkStateStore {
  load(): ChunkState;
  save(s: ChunkState): void;
  seed(): void;
  clear(): void;
  acquire(): boolean;
  release(): void;
  readTail(path: string, offset: number): string;
}

/**
 * Byte offset we've chunked up to, plus a lock serialising concurrent flushes —
 * rapid events spawn overlapping hook processes. A lock left behind by a crashed
 * flush is stolen after {@link STALE_LOCK_MS}.
 */
export function makeChunkState(sessionId: string): ChunkStateStore {
  const stateFile = `/tmp/claude-transcripts-${sessionId}.chunkstate`;
  const lockFile = `/tmp/claude-transcripts-${sessionId}.chunklock`;

  const load = (): ChunkState => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) as ChunkState;
    } catch {
      return { offset: 0, lastFlushMs: 0 };
    }
  };
  const save = (s: ChunkState): void => {
    try {
      writeFileSync(stateFile, JSON.stringify(s));
    } catch {
      // non-fatal
    }
  };

  return {
    load,
    save,
    // Baseline the flush timer at session start so the first interval measures from
    // now, not epoch 0 (which would always look elapsed).
    seed: () => save({ offset: 0, lastFlushMs: Date.now() }),
    clear() {
      for (const f of [stateFile, lockFile]) {
        try {
          unlinkSync(f);
        } catch {
          // already gone
        }
      }
    },
    acquire() {
      try {
        closeSync(openSync(lockFile, "wx")); // O_EXCL
        return true;
      } catch {
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
            unlinkSync(lockFile);
            closeSync(openSync(lockFile, "wx"));
            return true;
          }
        } catch {
          // lost the race / can't stat — treat as held
        }
        return false;
      }
    },
    release() {
      try {
        unlinkSync(lockFile);
      } catch {
        // already released
      }
    },
    readTail(path, offset) {
      const size = statSync(path).size;
      if (size <= offset) return "";
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        return buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
    },
  };
}

// ── Context ──────────────────────────────────────────────────────────────────

export interface HookContext {
  event: string;
  sessionId: string;
  cwd: string;
  hostname: string;
  timestamp: string;
  transcriptPath?: string;
  payload: any;
  config: HookConfig;
  couch: CouchClient;
  blob: BlobClient;
  counts: CountsStore;
  targets: TargetsStore;
  sessionsDb: string;
  sessionsBucket?: string;
}

const DEFAULT_SESSIONS_DB = "claude-transcripts-sessions";

export function buildContext(payload: any, config: HookConfig): HookContext | null {
  const event: string | undefined = payload?.hook_event_name;
  const sessionId: string | undefined = payload?.session_id;
  if (!event || !sessionId) return null;
  const targets = makeTargets(sessionId);
  return {
    event,
    sessionId,
    cwd: payload?.cwd ?? "",
    hostname: hostname(),
    timestamp: new Date().toISOString(),
    transcriptPath: payload?.transcript_path,
    payload,
    config,
    couch: makeCouch(config, (ok) => targets.markWrite(ok)),
    blob: makeBlob(config),
    counts: makeCounts(sessionId),
    targets,
    sessionsDb: config.couch.databases.sessions ?? DEFAULT_SESSIONS_DB,
    sessionsBucket: config.blob?.buckets.sessions,
  };
}

/** Fields stamped on every session doc (event / summary / chunk). */
export function commonFields(ctx: HookContext) {
  return {
    event: ctx.event,
    session_id: ctx.sessionId,
    timestamp: ctx.timestamp,
    hostname: ctx.hostname,
    cwd: ctx.cwd,
  };
}
