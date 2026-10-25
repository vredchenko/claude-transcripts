import { describe, expect, test } from "bun:test";
import type { HookTypeDef } from "./blueprint/types";
import {
  compareHookSpec,
  formatHookCompat,
  type HookSpec,
  hasDrift,
  parseSdkHookSpec,
  VERIFIED_HOOK_SPEC,
} from "./claude-code-spec";

/** A cut-down sdk.d.ts in the shape the SDK publishes: CRLF, JSDoc, aliases. */
const DTS = [
  "export declare type BaseHookInput = {",
  "    session_id: string;",
  "    /**",
  "     * A comment; with a semicolon { and a brace",
  "     */",
  "    effort?: {",
  "        level: string;",
  "    };",
  "};",
  "",
  "export declare const HOOK_EVENTS: readonly ['SessionStart', 'SessionEnd', 'PostModelSwitch'];",
  "",
  "export declare type ExitReason = 'clear' | 'other';",
  "",
  "export declare type SessionStartHookInput = BaseHookInput & {",
  "    hook_event_name: 'SessionStart';",
  "    source: 'startup' | 'resume' | 'fork';",
  "    model?: string;",
  "};",
  "",
  "export declare type SessionEndHookInput = BaseHookInput & {",
  "    hook_event_name: 'SessionEnd';",
  "    reason: ExitReason;",
  "};",
  "",
  "export declare type PostModelSwitchHookInput = (BaseHookInput & {",
  "    hook_event_name: 'PostModelSwitch';",
  "}) & {",
  "    to_model: string;",
  "};",
].join("\r\n");

const V = { claudeCode: "2.1.9", sdk: "0.3.9" };

describe("parseSdkHookSpec", () => {
  const spec = parseSdkHookSpec(DTS, V);

  test("lists the events in HOOK_EVENTS order", () => {
    expect(Object.keys(spec.events)).toEqual(["SessionStart", "SessionEnd", "PostModelSwitch"]);
  });

  test("reads common fields, a nested object as one field, and skips comments", () => {
    expect(spec.base).toEqual({ effort: [], session_id: [] });
  });

  test("records closed value sets, inline or via an alias", () => {
    expect(spec.events.SessionStart).toEqual({ model: [], source: ["fork", "resume", "startup"] });
    expect(spec.events.SessionEnd).toEqual({ reason: ["clear", "other"] });
  });

  test("reads a parenthesised intersection", () => {
    expect(spec.events.PostModelSwitch).toEqual({ to_model: [] });
  });

  test("takes double-quoted literals, as older releases wrote them", () => {
    const old = parseSdkHookSpec(DTS.replace(/'/g, '"'), V);
    expect(old).toEqual(spec);
  });

  test("refuses a file it can't read rather than returning an empty spec", () => {
    expect(() => parseSdkHookSpec("export declare type X = 1;", V)).toThrow(/HOOK_EVENTS/);
    expect(() => parseSdkHookSpec(DTS.replace(/readonly \[.*\]/, "readonly []"), V)).toThrow(
      /no HOOK_EVENTS/,
    );
  });
});

const hook = (event: string, wired: boolean): HookTypeDef => ({
  event,
  wired,
  category: "session-start",
  canBlock: false,
  summary: "",
});

describe("compareHookSpec", () => {
  const verified: HookSpec = {
    ...V,
    base: { session_id: [] },
    events: {
      SessionStart: { source: ["resume", "startup"] },
      Stop: { turn_number: [] },
      Setup: {},
    },
  };
  const catalogue = [hook("SessionStart", true), hook("Stop", true), hook("Setup", false)];

  test("the verified spec against itself is clean, in one line", () => {
    const r = compareHookSpec(catalogue, verified, "2.1.9", verified);
    expect(hasDrift(r)).toBe(false);
    expect(formatHookCompat(r)).toEqual([
      "✓ Hook spec matches Claude Code 2.1.9 (3 events, 2 recorded)",
    ]);
  });

  test("reports new, gone and changed events and fields", () => {
    const running: HookSpec = {
      claudeCode: "2.1.10",
      sdk: "0.3.10",
      base: { prompt_id: [], session_id: [] },
      events: {
        SessionStart: { source: ["fork", "resume", "startup"] },
        Stop: { last_assistant_message: [] },
        PostModelSwitch: {},
      },
    };
    const r = compareHookSpec(catalogue, verified, "2.1.10", running);
    expect(r.unlisted).toEqual(["PostModelSwitch"]);
    expect(r.goneWired).toEqual([]);
    expect(r.goneListed).toEqual(["Setup"]);
    expect(r.fields).toEqual([
      { event: "*", added: ["prompt_id"], removed: [] },
      { event: "SessionStart", added: ["source=fork"], removed: [] },
      { event: "Stop", added: ["last_assistant_message"], removed: ["turn_number"] },
    ]);
    expect(formatHookCompat(r)).toEqual([
      "△ Hook spec drift with Claude Code 2.1.10 (this build was checked against 2.1.9):",
      "  · new events we don't handle: PostModelSwitch",
      "  · listed, but no longer fired: Setup",
      "  · common fields: +prompt_id",
      "  · SessionStart: +source=fork",
      "  · Stop: +last_assistant_message −turn_number",
      "  Details: claude-transcripts compat",
    ]);
  });

  test("a recorded event that stopped firing comes first", () => {
    const running: HookSpec = {
      ...verified,
      events: { SessionStart: verified.events.SessionStart! },
    };
    const r = compareHookSpec(catalogue, verified, "2.1.9", running);
    expect(r.goneWired).toEqual(["Stop"]);
    expect(formatHookCompat(r)[1]).toBe("  · recorded, but no longer fired: Stop");
  });

  test("a version with no spec yet says so, and counts as drift", () => {
    const r = compareHookSpec(catalogue, verified, "2.1.11", null);
    expect(hasDrift(r)).toBe(true);
    expect(formatHookCompat(r)[0]).toStartWith(
      "? Hook spec for Claude Code 2.1.11 not checked yet",
    );
  });
});

test("the shipped spec is a real one", () => {
  expect(VERIFIED_HOOK_SPEC.claudeCode).toMatch(/^\d+\.\d+\.\d+$/);
  expect(Object.keys(VERIFIED_HOOK_SPEC.events)).toContain("SessionStart");
  expect(Object.keys(VERIFIED_HOOK_SPEC.base)).toContain("session_id");
});
