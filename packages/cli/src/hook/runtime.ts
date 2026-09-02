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
import type { RecallConfigFile } from "@claude-transcripts/shared";
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
  /** The deployment's recall section, if the config was written after it existed. */
  recall?: Partial<RecallConfigFile>;
}

/** Chunk tunables to fall back on; the same values the generated config template writes. */
const DEFAULT_CHUNK = { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } as const;

/**
 * Fill in what a hand-written config is allowed to leave out.
 *
 * `HookConfig.system` is declared non-optional, but nothing enforced that at the
 * boundary: `loadHookConfig` cast the parse result and handed it on, so a config
 * missing the key parsed cleanly and then threw on first dereference — inside a
 * handler, where the error is caught and logged and the session carries on. The
 * observed failure was a machine whose chunk flush had never once run, with no
 * symptom anywhere except an empty search index.
 *
 * A config is written by hand often enough (mirrors.md tells you to edit it, and a
 * client-only install has no `config/` to regenerate from) that "parses, therefore
 * usable" has to be true. Defaults here rather than guards at each use site, so the
 * next optional key doesn't reproduce the same bug somewhere else.
 */
export function normalizeHookConfig(raw: HookConfig): HookConfig {
  const chunk = raw.system?.logging?.chunk;
  return {
    ...raw,
    system: {
      ...raw.system,
      logging: {
        ...raw.system?.logging,
        chunk: {
          maxEntriesPerChunk: chunk?.maxEntriesPerChunk ?? DEFAULT_CHUNK.maxEntriesPerChunk,
          flushIntervalMs: chunk?.flushIntervalMs ?? DEFAULT_CHUNK.flushIntervalMs,
        },
      },
    },
  };
}

/** Load the runtime config, or null to silently do nothing (no install → no logging). */
export function loadHookConfig(path: string): HookConfig | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as HookConfig;
    // A config with no `couch` block cannot be made usable by defaulting — there is
    // nowhere to write. Reject it here, where the caller already handles null and says
    // so on SessionStart, rather than letting buildContext throw past every handler.
    if (!raw?.couch?.url) return null;
    return normalizeHookConfig(raw);
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
export function makeCouch(
  config: HookConfig,
  onWrite?: (ok: boolean, storeIndex: number) => void,
): CouchClient {
  const mirrors = config.mirrors ?? [];
  // Mirrors report their outcome too, but against their OWN index — reporting them
  // into a single shared pair would let a healthy mirror mark a dead primary as
  // recording, and the label the statusline prints is the primary's. The indices
  // here are the contract `resolveTargets` seeds `stores` in.
  return fanOutCouch([
    makeDirectCouch(config, onWrite && ((ok) => onWrite(ok, 0))),
    ...mirrors.map((m, i) => makeMirrorCouch(m, onWrite && ((ok) => onWrite(ok, i + 1)))),
  ]);
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
/**
 * One store's write health, kept per store rather than for the fan-out as a whole.
 *
 * A single outcome pair could not express "the primary is dead but the mirror is
 * fine", which is the ordinary state of a machine that reports into a shared
 * instance. Collapsing the two made the indicator wrong whichever way it resolved:
 * counting only the direct store showed a permanent failure on a machine that was
 * recording correctly, and counting any store showed a confident green dot labelled
 * with a host that had accepted nothing for weeks.
 *
 * Never carries credentials — labels come from {@link redactUrl}.
 */
export interface StoreHealth {
  /** `db@host` for the direct store, `host` for a mirror. */
  label: string;
  kind: "direct" | "mirror";
  /** Epoch ms of the last write this store accepted; 0 until one lands. */
  lastWriteMs: number;
  /** Epoch ms of the last write this store rejected after its last success; 0 if none. */
  lastFailureMs: number;
}

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
  /**
   * Per-store health: index 0 is the direct store, then mirrors in config order.
   *
   * Optional because it genuinely is absent on a targets file written by an older
   * binary — the file lives in `/tmp` per session and survives an upgrade mid-session.
   * A renderer must handle that rather than assume the key.
   */
  stores?: StoreHealth[];
  /**
   * Aggregate of {@link stores} (the best outcome across them).
   *
   * Kept for one release because the targets file lives in `/tmp` per session: a
   * session that started under an older binary and continues after an upgrade hands
   * the renderer a file with no `stores` key, and showing "off" at a live session
   * would be a worse lie than the one being fixed. Delete both next release.
   */
  lastWriteMs: number;
  /** See {@link lastWriteMs}. */
  lastFailureMs: number;
}

export interface TargetsStore {
  read(): Targets | null;
  write(t: Targets): void;
  /** Stamp the outcome of one CouchDB write against one store (0 = direct). */
  markWrite(ok: boolean, storeIndex?: number): void;
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
    markWrite(ok, storeIndex = 0) {
      const t = read();
      if (!t) return; // no session-start seed → nothing to annotate
      const now = Date.now();
      // A file written by an older binary has no `stores`; annotate what is there
      // rather than inventing entries whose labels we would have to guess.
      const store = t.stores?.[storeIndex];
      if (store) {
        if (ok) {
          store.lastWriteMs = now;
          store.lastFailureMs = 0;
        } else {
          store.lastFailureMs = now;
        }
      }
      // The flat pair stays the aggregate: any store accepting a write means the
      // session is being recorded somewhere, which is what the old renderer asked.
      if (ok) {
        t.lastWriteMs = now;
        t.lastFailureMs = 0;
      } else if (!t.stores?.some((x) => x.lastWriteMs > x.lastFailureMs)) {
        t.lastFailureMs = now;
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

/** `host:port` from a URL, credentials stripped — short enough for a statusline. */
export function hostOf(url: string): string {
  return redactUrl(url)
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
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
    // Order matters and is the contract `markWrite`'s index relies on: the direct
    // store first, then mirrors exactly as `makeCouch` fans them out.
    stores: [
      {
        label: `${config.couch.databases.sessions ?? DEFAULT_SESSIONS_DB}@${hostOf(config.couch.url)}`,
        kind: "direct",
        lastWriteMs: 0,
        lastFailureMs: 0,
      },
      ...(config.mirrors ?? []).map((m) => ({
        label: hostOf(m.url),
        kind: "mirror" as const,
        lastWriteMs: 0,
        lastFailureMs: 0,
      })),
    ],
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

export interface SessionStartOutput {
  systemMessage?: string;
  additionalContext?: string;
}

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
  /**
   * What SessionStart will print. Claude Code parses hook stdout as ONE JSON object,
   * so the actions that have something to say (`announce-recording`,
   * `inject-recall-policy`) fill this in and the dispatcher emits it once, after all
   * of them have settled.
   */
  output: SessionStartOutput;
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
    output: {},
    event,
    sessionId,
    cwd: payload?.cwd ?? "",
    hostname: hostname(),
    timestamp: new Date().toISOString(),
    transcriptPath: payload?.transcript_path,
    payload,
    config,
    couch: makeCouch(config, (ok, storeIndex) => targets.markWrite(ok, storeIndex)),
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
