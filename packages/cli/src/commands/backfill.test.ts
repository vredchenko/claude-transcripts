/**
 * `backfill --force`'s refusal to downgrade a live-recorded session.
 *
 * The case worth guarding is destructive and unrecoverable: `resetSession` deletes the
 * summary and every event marker *before* anything is rebuilt, so a wrong decision here
 * cannot be undone from inside the command. `--force` was written to redo a
 * reconstruction — a `source: "live"` record was written by the hook as the session
 * happened and carries provenance (`end_reason`, model, token usage, real per-event
 * markers) that the transcript cannot yield again.
 */
import { describe, expect, test } from "bun:test";
import { planReingest } from "./backfill";

const live = { source: "live" };
const backfilled = { source: "backfill" };

describe("planReingest", () => {
  test("a session with nothing stored is adopted", () => {
    expect(planReingest(null, { force: false, replaceLive: false })).toEqual({ action: "adopt" });
  });

  test("--force is not needed to adopt something new", () => {
    expect(planReingest(null, { force: true, replaceLive: false })).toEqual({ action: "adopt" });
  });

  test("an already-adopted session is skipped without --force", () => {
    expect(planReingest(backfilled, { force: false, replaceLive: false })).toEqual({
      action: "skip",
      reason: "already-adopted",
    });
  });

  test("--force rebuilds a reconstruction, which is what it is for", () => {
    expect(planReingest(backfilled, { force: true, replaceLive: false })).toEqual({
      action: "adopt",
    });
  });

  test("--force alone refuses a live record rather than replacing it", () => {
    expect(planReingest(live, { force: true, replaceLive: false })).toEqual({
      action: "skip",
      reason: "live-record",
    });
  });

  test("--replace-live opts in to replacing a live record", () => {
    expect(planReingest(live, { force: true, replaceLive: true })).toEqual({ action: "adopt" });
  });

  test("a live record is still skipped as already-adopted without --force", () => {
    // --replace-live widens what --force may overwrite; on its own it widens nothing.
    expect(planReingest(live, { force: false, replaceLive: true })).toEqual({
      action: "skip",
      reason: "already-adopted",
    });
  });

  test("an unknown source is treated as rebuildable, not as live", () => {
    // Only `live` carries irreplaceable provenance; a future source that does must opt
    // in here deliberately rather than inherit the guard by accident.
    expect(planReingest({ source: "doctor" }, { force: true, replaceLive: false })).toEqual({
      action: "adopt",
    });
  });
});
