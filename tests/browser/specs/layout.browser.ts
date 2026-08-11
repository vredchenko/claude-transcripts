/**
 * Geometric regressions: content that escapes its container, and pages that scroll
 * sideways.
 *
 * This is the suite's reason for existing. A transcript row whose preview is one long
 * unbroken string renders perfectly correct *text* while sitting hundreds of pixels
 * outside the card that should contain it — no content assertion can see that, and it
 * is precisely what a reader notices first. The corpus carries a line built for this
 * ({@link LONG_UNBROKEN_TEXT}), so the check has something to fail on.
 *
 * Runs at both configured widths, and against a live instance too — pointing this at a
 * real corpus is the fastest way to find which of your own sessions breaks a layout.
 *
 * Several checks here are currently {@link knownBroken}: they found real bugs on
 * arrival, and the fixes belong with the session-detail layout work rather than with
 * the harness. See `../helpers/known-broken.ts` for why they run rather than skip.
 */
import { expect, type Page, test } from "@playwright/test";
import { MULTI_DAY_SESSION, SEARCH_QUERY } from "../fixtures/corpus";
import {
  LIVE,
  SearchResultsPage,
  SessionDetailPage,
  SessionsListPage,
  setupPage,
} from "../helpers/app";
import { describeOverflows, hasHorizontalPageScroll, overflowingElements } from "../helpers/audit";
import { isMobile, knownBroken } from "../helpers/known-broken";

/** Assert nothing escapes its container and the page doesn't scroll sideways. */
async function expectNoOverflow(page: Page, where: string) {
  const overflows = await overflowingElements(page);
  expect(
    overflows,
    `${where}: content escapes its container\n${describeOverflows(overflows)}`,
  ).toEqual([]);
  expect(await hasHorizontalPageScroll(page), `${where}: the page scrolls horizontally`).toBe(
    false,
  );
}

test("the sessions list stays inside its container", async ({ page }) => {
  if (isMobile()) {
    // Two causes here, both needing a fix: the TableContainer doesn't confine the
    // table, and the header Toolbar overflows independently of it.
    knownBroken("the sessions table and the header both push the page wider than the viewport");
  }
  await setupPage(page);
  const list = new SessionsListPage(page);
  await list.goto();
  // The table itself is legitimately wider than the viewport on a narrow screen —
  // it lives in a TableContainer that scrolls, which the audit knows to allow. What
  // must not happen is the *page* scrolling with it.
  await expectNoOverflow(page, "sessions list");
});

test("session detail contains its transcript rows", async ({ page }) => {
  knownBroken(
    "MuiAccordionSummary-content is a flex container with no min-width:0, so a nowrap " +
      "preview forces the row to its max-content width and it spills out of the card",
  );
  await setupPage(page);
  const detail = new SessionDetailPage(page);
  await detail.goto(MULTI_DAY_SESSION.sessionId);
  await expect(detail.transcriptRows.first()).toBeVisible();
  await expectNoOverflow(page, "session detail (collapsed)");
});

test("an expanded transcript row contains its raw content", async ({ page }) => {
  knownBroken("the collapsed row already overflows, and expanding it does not help");
  await setupPage(page);
  const detail = new SessionDetailPage(page);
  await detail.goto(MULTI_DAY_SESSION.sessionId);
  // The unbroken line is the one that breaks things in both states: nowrap in the
  // summary, and an unwrappable <pre> once expanded.
  const row = detail.transcriptRows.filter({ hasText: "local-command-caveat" }).first();
  await row.click();
  await expectNoOverflow(page, "session detail (expanded row)");
});

test("the speaker-split view contains long turns", async ({ page }) => {
  if (isMobile()) {
    knownBroken("overflowing transcript rows cover the speaker toggle, so it can't be clicked");
  }
  await setupPage(page);
  const detail = new SessionDetailPage(page);
  await detail.goto(MULTI_DAY_SESSION.sessionId);
  await detail.selectSpeaker("You");
  await expect(page.getByText(/user turns?/)).toBeVisible();
  await expectNoOverflow(page, "speaker-split view");
});

test("search results contain long snippets", async ({ page }) => {
  if (isMobile()) {
    // Not the snippets — those wrap. The header's Toolbar does not fit 412px: its
    // middle (search) cell has no min-width:0, so it refuses to shrink and pushes the
    // settings/links menus off the right edge, scrolling every page in the app.
    knownBroken("the header Toolbar overflows at narrow widths, scrolling the whole page");
  }
  await setupPage(page);
  const search = new SearchResultsPage(page);
  await search.goto(SEARCH_QUERY);
  await expect(search.summaryLine).toBeVisible();
  await expectNoOverflow(page, "search results");
});

test("the header search dropdown contains long snippets", async ({ page }) => {
  test.skip(LIVE, "depends on what the corpus matches");
  if (isMobile()) {
    knownBroken("the header Toolbar overflows at narrow widths, scrolling the whole page");
  }
  await setupPage(page);
  await page.goto("/app/");
  await page.getByRole("textbox", { name: "Search sessions" }).fill(SEARCH_QUERY);
  await expect(page.getByText("In conversations")).toBeVisible();
  await expectNoOverflow(page, "search dropdown");
});
