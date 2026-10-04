/**
 * The recall policy's two hard rules: precedence (user → deployment → default), and
 * that the primer is *omitted* — not softened — when there is nothing to recall or the
 * policy says off. An empty corpus must not pay for a primer telling Claude to search it.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_RECALL, RECALL_ENV, recallPrimer, resolveRecall } from "./recall";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const where = { cwd: "/home/me/proj", hostname: "box" };

describe("resolveRecall", () => {
  test("config overrides defaults, deeply, without dropping siblings", () => {
    const r = resolveRecall({ mode: "suggest", triggers: { repeatedError: false } });
    expect(r.mode).toBe("suggest");
    expect(r.triggers).toEqual({
      priorWorkQuestion: true,
      repeatedError: false,
      beforeRederiving: true,
    });
    expect(r.primer).toEqual(DEFAULT_RECALL.primer);
  });

  test("the plugin's userConfig env wins over config", () => {
    const r = resolveRecall(
      { mode: "auto", scope: "project", maxResults: 5 },
      { [RECALL_ENV.mode]: "off", [RECALL_ENV.scope]: "all", [RECALL_ENV.maxResults]: "3" },
    );
    expect(r.mode).toBe("off");
    expect(r.scope).toBe("all");
    expect(r.maxResults).toBe(3);
  });

  test("an invalid env value is ignored, not applied", () => {
    const r = resolveRecall({}, { [RECALL_ENV.mode]: "loud", [RECALL_ENV.maxResults]: "-1" });
    expect(r.mode).toBe("auto");
    expect(r.maxResults).toBe(5);
  });
});

describe("recallPrimer", () => {
  test("names the count, the recency and the scoped command, within budget", () => {
    const text = recallPrimer(
      DEFAULT_RECALL,
      { sessionCount: 37, mostRecent: "2026-08-26T09:00:00Z" },
      where,
      NOW,
    );
    expect(text).toContain("37 recorded sessions");
    expect(text).toContain("most recent 2 days ago");
    expect(text).toContain(
      'claude-transcripts search "<query>" --cwd "/home/me/proj" --json --limit 5',
    );
    // Budget: well under primer.maxTokens (~200 tokens ≈ 800 chars).
    expect((text ?? "").length).toBeLessThan(700);
  });

  test("suggest mode asks instead of acting", () => {
    const text = recallPrimer(
      { ...DEFAULT_RECALL, mode: "suggest" },
      { sessionCount: 1 },
      where,
      NOW,
    );
    expect(text).toContain("offer to search history");
  });

  test("omitted when off, when the primer is disabled, and when the corpus is empty", () => {
    expect(
      recallPrimer({ ...DEFAULT_RECALL, mode: "off" }, { sessionCount: 9 }, where, NOW),
    ).toBeNull();
    expect(
      recallPrimer(
        { ...DEFAULT_RECALL, primer: { onSessionStart: false, maxTokens: 200 } },
        { sessionCount: 9 },
        where,
        NOW,
      ),
    ).toBeNull();
    expect(recallPrimer(DEFAULT_RECALL, { sessionCount: 0 }, where, NOW)).toBeNull();
  });
});
