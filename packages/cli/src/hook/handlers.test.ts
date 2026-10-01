/** `implemented` in the app model ⇔ a `HANDLERS` entry. Lives here: shared can't import cli. */
import { describe, expect, test } from "bun:test";
import { ACTIONS, BINDINGS } from "@claude-transcripts/shared";
import { HANDLERS } from "./handlers";

describe("HANDLERS ↔ ACTIONS", () => {
  test("every handler is for a catalogued action", () => {
    const known = new Set(ACTIONS.map((a) => a.key));
    const unknown = Object.keys(HANDLERS).filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  test("an action is implemented exactly when it has a handler", () => {
    const implemented = ACTIONS.filter((a) => a.implemented)
      .map((a) => a.key)
      .sort();
    expect(implemented).toEqual(Object.keys(HANDLERS).sort());
  });

  test("every action bound to an event has a handler", () => {
    const unhandled = BINDINGS.flatMap(({ event, actions }) =>
      actions.filter((a) => !HANDLERS[a]).map((a) => `${event} → ${a}`),
    );
    expect(unhandled).toEqual([]);
  });
});
