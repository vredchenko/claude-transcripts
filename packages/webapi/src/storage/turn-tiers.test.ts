/**
 * The live/archive split for turns (ADR 0032): which index a session's turns belong in,
 * and the swap-based rebuild that keeps an index searchable while it is replaced.
 */
import { describe, expect, test } from "bun:test";
import type { Meili } from "./meili";
import { belongsLive, rebuildIndex, sessionFilter } from "./turn-tiers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

describe("belongsLive", () => {
  test("a running session is live", () => {
    expect(belongsLive({ last: "2026-11-01T11:00:00.000Z" } as any, NOW, DAY)).toBe(true);
  });

  test("an ended session is archived, however recent", () => {
    const agg = { last: "2026-11-01T11:59:00.000Z", summary: { session_id: "s" } } as any;
    expect(belongsLive(agg, NOW, DAY)).toBe(false);
  });

  test("one that went quiet past the live window is archived, ended or not", () => {
    // Without this a crashed session, with the reconcile sweep off, stays live forever.
    expect(belongsLive({ last: "2026-10-30T00:00:00.000Z" } as any, NOW, DAY)).toBe(false);
  });

  test("an unknown session is live until the maintenance pass says otherwise", () => {
    expect(belongsLive(undefined, NOW, DAY)).toBe(true);
  });
});

describe("sessionFilter", () => {
  test("quotes ids, so one can't break out of the filter", () => {
    expect(sessionFilter(["a", 'b"c'])).toBe('sessionId IN ["a", "b\\"c"]');
  });
});

/** A Meili stand-in that logs calls; `reject` makes document batches fail validation. */
function fakeMeili(reject = false) {
  const log: string[] = [];
  let next = 0;
  const meili = {
    async deleteIndex(uid: string) {
      log.push(`drop ${uid}`);
      return next++;
    },
    async ensureIndex(uid: string) {
      log.push(`ensure ${uid}`);
    },
    async index(uid: string, docs: any[]) {
      log.push(`index ${uid} ${docs.length}`);
      return reject ? -1 : next++;
    },
    async swapIndexes(a: string, b: string) {
      log.push(`swap ${a} ${b}`);
      return next++;
    },
    async taskFailures(uids: number[]) {
      return uids.includes(-1)
        ? { indexed: 0, failures: ["invalid_document_id"] }
        : { indexed: 2, failures: [] };
    },
  };
  return { meili: meili as unknown as Meili, log };
}

describe("rebuildIndex", () => {
  test("fills a side index, then swaps it in and drops the old contents", async () => {
    const { meili, log } = fakeMeili();
    const res = await rebuildIndex(meili, "x", {}, [{ id: "a" }, { id: "b" }]);

    expect(res).toEqual({ indexed: 2, failures: [] });
    expect(log).toEqual([
      "drop x-rebuild",
      "ensure x-rebuild",
      "ensure x",
      "index x-rebuild 2",
      "swap x x-rebuild",
      "drop x-rebuild",
    ]);
  });

  test("a rejected fill leaves the real index alone", async () => {
    const { meili, log } = fakeMeili(true);
    const res = await rebuildIndex(meili, "x", {}, [{ id: "a" }]);

    expect(res.failures).toEqual(["invalid_document_id"]);
    expect(log.some((l) => l.startsWith("swap"))).toBe(false);
    expect(log.at(-1)).toBe("drop x-rebuild");
  });
});
