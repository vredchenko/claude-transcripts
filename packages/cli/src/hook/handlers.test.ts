/**
 * `implemented` in the blueprint ⇔ something runs the action: a `HANDLERS` entry when
 * an event is bound to it, else the CLI command its `triggers.cli` names. Lives here:
 * shared can't import cli.
 */
import { describe, expect, test } from "bun:test";
import { ACTIONS, BINDINGS } from "@claude-transcripts/shared";
import { COMMANDS } from "../commands";
import { HANDLERS } from "./handlers";

const bound = new Set(BINDINGS.flatMap((b) => b.actions));

describe("HANDLERS ↔ ACTIONS", () => {
  test("a bound action is implemented exactly when it has a handler", () => {
    const implemented = ACTIONS.filter((a) => a.implemented && bound.has(a.key))
      .map((a) => a.key)
      .sort();
    expect(implemented).toEqual(Object.keys(HANDLERS).sort());
  });

  test("an unbound implemented action runs as the CLI command it names", () => {
    const missing = ACTIONS.filter((a) => a.implemented && !bound.has(a.key))
      .filter((a) => !a.triggers?.cli || !COMMANDS[a.triggers.cli])
      .map((a) => a.key);
    expect(missing).toEqual([]);
  });

  test("every action bound to an event has a handler", () => {
    const unhandled = BINDINGS.flatMap(({ event, actions }) =>
      actions.filter((a) => !HANDLERS[a]).map((a) => `${event} → ${a}`),
    );
    expect(unhandled).toEqual([]);
  });
});
