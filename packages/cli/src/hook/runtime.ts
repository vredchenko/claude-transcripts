/**
 * Hook runtime for the installed CLI.
 *
 * A user install has neither Bun nor a repo checkout, so the hook can't be
 * `bun run <repo>/hooks/scripts/dispatch.ts` — the registered command is the CLI
 * binary itself (`claude-transcripts hook run`, see installation.md). This module is
 * that hook: it reads the same runtime config the standalone plugin reads, so both
 * forms behave identically and an install can move between them.
 *
 * It writes through the instance's webapi and nowhere else (#288, `ingest.ts`). Two
 * rules hold everywhere: **the hook never blocks a session** — every call is bounded
 * and the process always exits 0 — and **a failed write is never silent**: each
 * outcome is stamped where the statusline reads it, with the reason.
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
import { hookCompatLines } from "./compat";
import { spawnDetached, uploadArgv } from "./detach";
import {
  fanOut,
  fetchChunkHighWater,
  type IngestClient,
  makeIngestClient,
  probeWebapi,
  redundantMirrors,
  type WebapiTarget,
  type WriteOutcome,
} from "./ingest";

/**
 * Mirrors in the config at `path` whose URL is its own `webapi.url` (#306), read from
 * the file as written — {@link loadHookConfig} already drops them, so this is what
 * `hook status` and `doctor` use to say they are there and should be removed.
 */
export function redundantMirrorsIn(path: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HookConfig>;
    return redundantMirrors(raw?.webapi, raw?.mirrors);
  } catch {
    return [];
  }
}

export interface HookConfig {
  /**
   * The instance's webapi — the hook's write target, and the only one it needs. A
   * config without it records nothing ({@link hookConfigProblem} says why).
   */
  webapi: WebapiTarget;
  /** Additional webapis that receive the same writes (`docs/operate/mirrors.md`). */
  mirrors?: WebapiTarget[];
  /**
   * Store blocks written by releases before #288, when the hook wrote CouchDB and S3
   * directly. Ignored: the hook no longer reads them, and they hold credentials this
   * machine no longer needs — `setup` drops them on its next run.
   */
  couch?: unknown;
  blob?: unknown;
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
  // A mirror that is the instance itself would receive every write twice (#306).
  // Dropped here so a hand-edited or pre-0.11 config can't double-write even before
  // `setup` rewrites it; `hook status` and `doctor` say it is there.
  const mirrors = Array.isArray(raw.mirrors)
    ? raw.mirrors.filter((m) => redundantMirrors(raw.webapi, [m]).length === 0)
    : raw.mirrors;
  return {
    ...raw,
    ...(mirrors === undefined ? {} : { mirrors }),
    features: raw.features ?? {},
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

/** Load the runtime config, or null when it can't record ({@link hookConfigProblem}). */
export function loadHookConfig(path: string): HookConfig | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as HookConfig;
    // Without a webapi there is nowhere to write — and no defaulting can invent one.
    // Rejected here, where the caller already handles null and says so on SessionStart,
    // rather than letting buildContext throw past every handler.
    if (!raw?.webapi?.url) return null;
    return normalizeHookConfig(raw);
  } catch {
    return null;
  }
}

/**
 * Why the config at `path` can't record, in one line for the session-start banner —
 * or null when it can. The legacy case is the one worth naming: a config written
 * before #288 holds store credentials but no webapi, and looks perfectly healthy.
 */
export function hookConfigProblem(path: string): string | null {
  let raw: Partial<HookConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HookConfig>;
  } catch {
    return "no instance configured. Run `claude-transcripts install`";
  }
  if (raw?.webapi?.url) return null;
  if (raw?.couch || raw?.blob) {
    return (
      "this machine's config names the stores but no webapi, and the hook now writes only " +
      "through the webapi. Run `claude-transcripts setup` (or add `webapi.url` to " +
      `${path})`
    );
  }
  return `no webapi configured in ${path}. Run \`claude-transcripts setup\``;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The hook's writer: the instance's webapi, then any mirrors, written together.
 *
 * Each target reports its outcome against its own index — the contract
 * {@link resolveTargets} seeds `stores` in — so a healthy mirror can never mark a dead
 * instance as recording, or the reverse.
 */
export function makeWriter(
  config: HookConfig,
  onWrite?: (outcome: WriteOutcome, storeIndex: number) => void,
): IngestClient {
  const targets = [config.webapi, ...(config.mirrors ?? [])];
  return fanOut(targets.map((t, i) => makeIngestClient(t, onWrite && ((o) => onWrite(o, i)))));
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
 * One write target's health, kept per target rather than for the fan-out as a whole.
 *
 * A single outcome pair could not express "the instance is down but the mirror is
 * fine", which is the ordinary state of a machine that reports into a shared
 * instance. Collapsing the two made the indicator wrong whichever way it resolved.
 *
 * Never carries credentials — labels come from {@link hostOf}.
 */
export interface StoreHealth {
  /** The target's `host:port`. */
  label: string;
  /**
   * `webapi` for the instance, `mirror` for the rest. `direct` is a store written
   * directly, which only a targets file from before #288 still says.
   */
  kind: "webapi" | "mirror" | "direct";
  /** Epoch ms of the last write this target accepted; 0 until one lands. */
  lastWriteMs: number;
  /** Epoch ms of the last write this target rejected after its last success; 0 if none. */
  lastFailureMs: number;
  /** Why the last failure failed (`HTTP 503`, `timeout`, `unreachable`); absent if none. */
  lastError?: string;
}

export interface Targets {
  /** The instance's webapi, credentials stripped — the write target and the deep link. */
  webapiUrl?: string;
  /** Feature flags that were on when the session started. */
  features: string[];
  /** Mirrors this machine also reports into (URLs only). */
  mirrors: string[];
  /**
   * Per-target health: index 0 is the instance's webapi, then mirrors in config order.
   *
   * Optional because it genuinely is absent on a targets file written by an older
   * binary — the file lives in `/tmp` per session and survives an upgrade mid-session.
   * A renderer must handle that rather than assume the key.
   */
  stores?: StoreHealth[];
  /** Aggregate of {@link stores} (the best outcome across them). */
  lastWriteMs: number;
  /** See {@link lastWriteMs}. */
  lastFailureMs: number;
  /**
   * Pre-#288 fields: a session that started under an older binary still has them in
   * its `/tmp` targets file. Read only by the renderer's fallback for such a file.
   */
  couchUrl?: string;
  sessionsDb?: string;
  bucket?: string;
}

export interface TargetsStore {
  read(): Targets | null;
  write(t: Targets): void;
  /** Stamp the outcome of one write against one target (0 = the instance's webapi). */
  markWrite(outcome: WriteOutcome | boolean, storeIndex?: number): void;
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
    markWrite(outcome, storeIndex = 0) {
      const o: WriteOutcome =
        typeof outcome === "boolean"
          ? outcome
            ? { ok: true }
            : { ok: false, reason: "failed" }
          : outcome;
      const t = read();
      if (!t) return; // no session-start seed → nothing to annotate
      const now = Date.now();
      // A file written by an older binary has no `stores`; annotate what is there
      // rather than inventing entries whose labels we would have to guess.
      const store = t.stores?.[storeIndex];
      if (store) {
        if (o.ok) {
          store.lastWriteMs = now;
          store.lastFailureMs = 0;
          delete store.lastError;
        } else {
          store.lastFailureMs = now;
          store.lastError = o.reason;
        }
      }
      // The flat pair stays the aggregate: any target accepting a write means the
      // session is being recorded somewhere.
      if (o.ok) {
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
export function resolveTargets(config: HookConfig): Targets {
  const health = (url: string, kind: StoreHealth["kind"]): StoreHealth => ({
    label: hostOf(url),
    kind,
    lastWriteMs: 0,
    lastFailureMs: 0,
  });
  return {
    webapiUrl: redactUrl(config.webapi.url),
    features: Object.entries(config.features ?? {})
      .filter(([, on]) => on)
      .map(([k]) => k),
    mirrors: (config.mirrors ?? []).map((m) => redactUrl(m.url)),
    // Order matters and is the contract `markWrite`'s index relies on: the instance
    // first, then mirrors exactly as `makeWriter` fans them out.
    stores: [
      health(config.webapi.url, "webapi"),
      ...(config.mirrors ?? []).map((m) => health(m.url, "mirror")),
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
  /** Start the offset at `offset` (0 for a new transcript) with a fresh flush baseline. */
  seed(offset?: number): void;
  acquire(): boolean;
  release(): void;
  readTail(path: string, offset: number): string;
}

/**
 * Byte offset we've chunked up to, plus a lock serialising concurrent flushes —
 * rapid events spawn overlapping hook processes. A lock left behind by a crashed
 * flush is stolen after {@link STALE_LOCK_MS}.
 *
 * The state file is never deleted: a resume after SessionEnd continues from its offset
 * (#168). It is a few bytes, and `/tmp` is swept by the OS.
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
    seed: (offset = 0) => save({ offset, lastFlushMs: Date.now() }),
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
  /** Extra lines shown under `systemMessage` (the hook-spec check), in one banner. */
  notices?: string[];
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
  /** Every write goes here: the instance's webapi plus mirrors ({@link makeWriter}). */
  writer: IngestClient;
  counts: CountsStore;
  targets: TargetsStore;
  /**
   * What SessionStart will print. Claude Code parses hook stdout as ONE JSON object,
   * so the actions that have something to say (`announce-recording`,
   * `inject-recall-policy`) fill this in and the dispatcher emits it once, after all
   * of them have settled.
   */
  output: SessionStartOutput;
  /**
   * The highest `byte_end` this session's chunks reach, from the instance's webapi, or
   * null when there are none or it can't say in time. Lets a resume pick up the offset
   * when `/tmp` lost it.
   */
  chunkHighWater(): Promise<number | null>;
  /** Ask whether the instance's webapi can take writes now (session start only). */
  probe(): Promise<WriteOutcome>;
  /**
   * Start this session's transcript upload in a detached process; false if it could
   * not start. A seam so tests don't spawn — the real one is `spawnDetached`.
   */
  detachUpload(sessionId: string, transcriptPath: string): boolean;
  /**
   * The hook-spec compatibility lines for this session's Claude Code. A seam so tests
   * neither run `claude --version` nor spawn a fetch — the real one is `hookCompatLines`.
   */
  hookCompat(): string[];
}

export function buildContext(payload: any, config: HookConfig): HookContext | null {
  const event: string | undefined = payload?.hook_event_name;
  const sessionId: string | undefined = payload?.session_id;
  if (!event || !sessionId) return null;
  const targets = makeTargets(sessionId);
  return {
    output: {},
    hookCompat: () => hookCompatLines(),
    chunkHighWater: () => fetchChunkHighWater(config.webapi, sessionId),
    probe: () => probeWebapi(config.webapi),
    event,
    sessionId,
    cwd: payload?.cwd ?? "",
    hostname: hostname(),
    timestamp: new Date().toISOString(),
    transcriptPath: payload?.transcript_path,
    payload,
    config,
    writer: makeWriter(config, (outcome, i) => targets.markWrite(outcome, i)),
    counts: makeCounts(sessionId),
    targets,
    detachUpload: (sid, path) => spawnDetached(uploadArgv(sid, path)),
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
