/**
 * The spec (what help advertises) and the registry (what runs) are two lists, and
 * they drifted once: `search` sat in CLI_SPEC for months while `search anything`
 * fell through to the help screen (#100). Keep them equal in both directions.
 */
import { expect, test } from "bun:test";
import { CLI_SPEC } from "@claude-transcripts/shared";
import { COMMANDS } from "./index";

test("every CLI_SPEC command has a runner, and every runner is in CLI_SPEC", () => {
  const spec = CLI_SPEC.commands.map((c) => c.name).sort();
  const registry = Object.keys(COMMANDS).sort();
  expect(registry).toEqual(spec);
});
