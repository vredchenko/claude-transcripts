/**
 * Per-session running counters (events / prompts / errors / tool usage),
 * persisted to a small /tmp file so they survive across the many short-lived hook
 * invocations within one session and are summed at SessionEnd.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface Counts {
  events: number;
  prompts: number;
  errors: number;
  tools: Record<string, number>;
}

export interface CountsStore {
  read(): Counts;
  reset(): void;
  inc(key: "events" | "prompts" | "errors"): void;
  incTool(tool: string): void;
  clear(): void;
}

const empty = (): Counts => ({ events: 0, prompts: 0, errors: 0, tools: {} });

export function makeCounts(sessionId: string): CountsStore {
  const file = `/tmp/claude-transcripts-${sessionId}.counts`;

  const read = (): Counts => {
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as Counts;
    } catch {
      return empty();
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
    reset() {
      write(empty());
    },
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
