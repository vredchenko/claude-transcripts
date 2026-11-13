import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_ASSETS } from "./assets.generated";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("EMBEDDED_ASSETS", () => {
  // The generator writes template literals, so escaping is the one thing that can go
  // wrong: every asset must come back byte for byte, `${`, backticks and backslashes too.
  test.each(Object.entries(EMBEDDED_ASSETS))("%s matches its source file", (_key, asset) => {
    const content: string = asset.content;
    expect(content).toBe(readFileSync(join(ROOT, asset.source), "utf8"));
  });
});
