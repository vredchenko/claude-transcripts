/**
 * The registration invariant: a hook may only be fire-and-forget if nothing it does
 * needs to reach the session or survive teardown.
 *
 * These assert against the real `BINDINGS`, not a copy, so adding an output-producing
 * action to an event that is currently async fails here rather than silently dropping
 * the banner, the recall primer, or a transcript upload in the field.
 */
import { describe, expect, test } from "bun:test";
import { BINDINGS } from "@claude-transcripts/shared";
import { hookAsync, hookTimeout } from "./index";

/** Actions whose whole point is to write into the session — async discards their output. */
const EMITS_INTO_SESSION = new Set(["announce-recording", "inject-recall-policy"]);
/** Actions that must finish before the process can go away. */
const MUST_COMPLETE = new Set(["write-summary", "upload-blobs"]);

describe("hookAsync", () => {
  test("no async event carries an action whose output reaches the session", () => {
    for (const { event, actions } of BINDINGS) {
      if (!hookAsync(event)) continue;
      const offenders = actions.filter((a) => EMITS_INTO_SESSION.has(a));
      expect(`${event}: ${offenders.join(",")}`).toBe(`${event}: `);
    }
  });

  test("no async event carries an action that must complete before exit", () => {
    for (const { event, actions } of BINDINGS) {
      if (!hookAsync(event)) continue;
      const offenders = actions.filter((a) => MUST_COMPLETE.has(a));
      expect(`${event}: ${offenders.join(",")}`).toBe(`${event}: `);
    }
  });

  test("SessionStart stays synchronous — it emits the banner and the recall primer", () => {
    expect(hookAsync("SessionStart")).toBe(false);
  });

  test("SessionEnd stays synchronous — it uploads the transcript", () => {
    expect(hookAsync("SessionEnd")).toBe(false);
  });

  test("UserPromptSubmit stays synchronous — Claude Code ignores async there", () => {
    expect(hookAsync("UserPromptSubmit")).toBe(false);
  });

  test("the frequent observer events are async — this is the point of the flag", () => {
    for (const event of [
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "PreCompact",
      "PostCompact",
    ]) {
      expect(hookAsync(event)).toBe(true);
    }
  });

  test("every bound event is decided one way or the other", () => {
    for (const { event } of BINDINGS) {
      expect(typeof hookAsync(event)).toBe("boolean");
    }
  });
});

describe("hookTimeout", () => {
  test("the two events that do real work get the long budget", () => {
    expect(hookTimeout("SessionStart")).toBe(180);
    expect(hookTimeout("SessionEnd")).toBe(180);
  });

  test("everything else is a small append", () => {
    expect(hookTimeout("PostToolUse")).toBe(5);
    expect(hookTimeout("Stop")).toBe(5);
  });
});
