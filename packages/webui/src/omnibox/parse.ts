/**
 * Pure omnibox input parser — no React, no side effects.
 *
 * Detects mode from the raw input: plain text, operator (`key:value`), date
 * phrases, hex id prefix, or command (`>` prefix).
 */

export type OmniboxMode = "text" | "operator" | "date" | "id" | "command";

export interface OperatorToken {
  key: string;
  op: string; // ":" | ">" | "<" | ">=" | "<=" | "="
  value: string;
  raw: string;
}

export interface DateRange {
  from: string; // ISO
  to: string; // ISO
}

export interface OmniboxParse {
  mode: OmniboxMode;
  raw: string;
  /** For `text` mode: the plain search terms. */
  text?: string;
  /** For `operator` mode: parsed operator tokens. */
  operators?: OperatorToken[];
  /** For `date` mode: resolved date range. */
  dateRange?: DateRange;
  /** For `id` mode: the hex prefix. */
  idPrefix?: string;
  /** For `command` mode: the command string after `>`. */
  command?: string;
}

/** Operator keys the omnibox recognises. */
export const OPERATORS: Record<string, string> = {
  "project:": "Filter by project (cwd)",
  "host:": "Filter by hostname",
  "model:": "Filter by model name",
  "source:": "Filter by recording source",
  "errors:>0": "Sessions with errors",
  "tokens:>1M": "Sessions with many tokens",
  "runtime:>1h": "Sessions longer than 1 hour",
  "active:<10%": "Sessions with low activity",
};

const OPERATOR_REGEX = /^(\w+)([:><=!]+)(.+)$/;
const HEX_ID_REGEX = /^[0-9a-f]{4,}$/i;

/** Parse a date phrase into an ISO range relative to `now`. */
function parseDatePhrase(phrase: string, now: Date): DateRange | undefined {
  const lower = phrase.toLowerCase().trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (lower === "today") {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { from: today.toISOString(), to: tomorrow.toISOString() };
  }
  if (lower === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return { from: yesterday.toISOString(), to: today.toISOString() };
  }
  if (lower === "this week") {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return { from: weekStart.toISOString(), to: weekEnd.toISOString() };
  }
  if (lower === "last week") {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7) - 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return { from: weekStart.toISOString(), to: weekEnd.toISOString() };
  }
  if (lower === "this month") {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return { from: monthStart.toISOString(), to: monthEnd.toISOString() };
  }
  if (lower === "last month") {
    const monthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: monthStart.toISOString(), to: monthEnd.toISOString() };
  }

  // Try "aug 19", "august 19", "19 aug", etc.
  const monthNames: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  const dateMatch = lower.match(/^(\w+)\s+(\d{1,2})$/) ?? lower.match(/^(\d{1,2})\s+(\w+)$/);
  if (dateMatch) {
    const parts = [dateMatch[1]!, dateMatch[2]!];
    const monthPart = parts.find((p) => monthNames[p] !== undefined);
    const dayPart = parts.find((p) => /^\d+$/.test(p));
    if (monthPart && dayPart) {
      const month = monthNames[monthPart]!;
      const day = Number.parseInt(dayPart, 10);
      const start = new Date(now.getFullYear(), month, day);
      const end = new Date(now.getFullYear(), month, day + 1);
      return { from: start.toISOString(), to: end.toISOString() };
    }
  }

  return undefined;
}

const DATE_PHRASES = ["today", "yesterday", "this week", "last week", "this month", "last month"];

export function parseOmniboxInput(raw: string, now = new Date()): OmniboxParse {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: "text", raw, text: "" };

  // Command mode: `>` prefix.
  if (trimmed.startsWith(">")) {
    return { mode: "command", raw, command: trimmed.slice(1).trim() };
  }

  // Id mode: 4+ hex characters.
  if (HEX_ID_REGEX.test(trimmed)) {
    return { mode: "id", raw, idPrefix: trimmed.toLowerCase() };
  }

  // Date mode: recognised date phrases.
  const dateRange = parseDatePhrase(trimmed, now);
  if (dateRange) {
    return { mode: "date", raw, dateRange };
  }
  // Partial date phrase detection.
  if (DATE_PHRASES.some((p) => p.startsWith(trimmed.toLowerCase()))) {
    return { mode: "date", raw };
  }

  // Operator mode: `key:value` or `key>value` tokens.
  const tokens = trimmed.split(/\s+/);
  const operators: OperatorToken[] = [];
  for (const token of tokens) {
    const match = OPERATOR_REGEX.exec(token);
    if (match) {
      operators.push({ key: match[1]!, op: match[2]!, value: match[3]!, raw: token });
    }
  }
  if (operators.length > 0) {
    return { mode: "operator", raw, operators };
  }

  // Default: text mode.
  return { mode: "text", raw, text: trimmed };
}
