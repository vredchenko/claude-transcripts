/**
 * Marking a check as *currently* failing, without deleting it.
 *
 * When this suite arrived it immediately found layout bugs that predate it. Two of the
 * usual responses are both wrong: deleting the check loses the finding, and leaving it
 * red makes CI meaningless, which quickly makes the whole suite ignorable.
 *
 * So the check stays, runs, and is declared expected-to-fail. The important property is
 * that this is **self-clearing**: the moment the bug is fixed the test passes, and
 * Playwright reports a passing expected-failure as a *failure* ("expected to fail but
 * passed"). Nobody has to remember to come back and re-enable it — the suite insists.
 * Fixing the bug therefore includes deleting its `knownBroken(...)` line, which is
 * exactly the diff a reviewer wants to see.
 *
 * `test.skip()` has neither property, which is why it isn't used here.
 */
import { test } from "@playwright/test";

/**
 * Declare that the surrounding test currently fails, and why.
 *
 * Call at the top of the test body. `reason` should say what is broken, not what the
 * test does — it's read by whoever is about to delete the line.
 */
export function knownBroken(reason: string): void {
  test.fail(true, reason);
  // Several of these bugs shift content out from under the cursor, so a click that
  // should be instant instead retries until the default timeout. There's no value in
  // waiting the full 30s to confirm a failure we've already declared.
  test.setTimeout(20_000);
}

/**
 * True when the current test is running at the narrow viewport, on either engine.
 *
 * Matched on the project name's suffix rather than by an equality check, so adding a
 * third engine doesn't silently stop a narrow-width marker from applying to it.
 */
export function isMobile(): boolean {
  return test.info().project.name.endsWith("-mobile");
}

/** True when the current test is running on Firefox — for a genuine engine difference. */
export function isFirefox(): boolean {
  return test.info().project.name.startsWith("firefox-");
}
