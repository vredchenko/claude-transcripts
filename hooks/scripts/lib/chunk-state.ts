/**
 * Per-session mid-flight chunk state: the byte offset we've chunked up to, the last
 * flush time, and a flush lock — persisted to /tmp so they survive the many
 * short-lived hook invocations within one session (like counts.ts). The lock
 * serialises concurrent flushes (rapid events spawn overlapping processes); a stale
 * lock (from a crashed flush) is stolen after STALE_LOCK_MS.
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

export interface ChunkState {
  /** absolute byte offset in the transcript we've emitted chunks up to */
  offset: number;
  /** epoch ms of the last emitted flush (for the time-based flush) */
  lastFlushMs: number;
}

const STALE_LOCK_MS = 30_000;
const empty = (): ChunkState => ({ offset: 0, lastFlushMs: 0 });

export interface ChunkStateStore {
  load(): ChunkState;
  save(s: ChunkState): void;
  seed(): void;
  clear(): void;
  /** Acquire the flush lock; false if another flush holds a fresh lock (skip). */
  acquire(): boolean;
  release(): void;
  /** Read transcript bytes from `offset` to EOF — only the new tail, not the whole file. */
  readTail(path: string, offset: number): string;
}

export function makeChunkState(sessionId: string): ChunkStateStore {
  const stateFile = `/tmp/claude-transcripts-${sessionId}.chunkstate`;
  const lockFile = `/tmp/claude-transcripts-${sessionId}.chunklock`;

  const load = (): ChunkState => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) as ChunkState;
    } catch {
      return empty();
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
    // Baseline the flush timer at session start, so the first flush measures elapsed
    // time from *now* (not epoch 0, which would always look "elapsed").
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
        closeSync(openSync(lockFile, "wx")); // O_EXCL: fails if it exists
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
