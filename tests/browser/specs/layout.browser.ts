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
 * Every check here failed when the suite arrived, at one width or both. They pass now;
 * the two causes were both a flex child missing `min-width: 0` (the transcript rows,
 * and the header's search cell), which is the shape to suspect first when one of these
 * goes red again.
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

test("the header search box stays usable at every width", async ({ page }) => {
  await setupPage(page);
  const list = new SessionsListPage(page);
  await list.goto();

  // "Fits" isn't enough. Making the toolbar fit by letting the search field shrink
  // produced a ~20px input pressed against the settings button — no overflow, nothing
  // for the geometry audit to catch, and completely unusable. Below `sm` the toolbar
  // wraps and the field takes its own row instead.
  const box = await page.getByRole("textbox", { name: "Search sessions" }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width, "the search field collapsed").toBeGreaterThan(180);
});

test("the sessions list stays inside its container", async ({ page }) => {
  await setupPage(page);
  const list = new SessionsListPage(page);
  await list.goto();
  // The table is legitimately wider than a narrow viewport — it lives in a
  // TableContainer that scrolls, which the audit knows to allow. What must not happen
  // is the *page* scrolling with it.
  await expectNoOverflow(page, "sessions list");
});

test("session detail contains its transcript rows", async ({ page }) => {
  await setupPage(page);
  const detail = new SessionDetailPage(page);
  await detail.goto(MULTI_DAY_SESSION.sessionId);
  await expect(detail.transcriptRows.first()).toBeVisible();
  await expectNoOverflow(page, "session detail (collapsed)");
});

test("an expanded transcript row contains its raw content", async ({ page }) => {
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
  await setupPage(page);
  const detail = new SessionDetailPage(page);
  await detail.goto(MULTI_DAY_SESSION.sessionId);
  await detail.selectSpeaker("You");
  await expect(page.getByText(/user turns?/)).toBeVisible();
  await expectNoOverflow(page, "speaker-split view");
});

test("search results contain long snippets", async ({ page }) => {
  await setupPage(page);
  const search = new SearchResultsPage(page);
  await search.goto(SEARCH_QUERY);
  await expect(search.summaryLine).toBeVisible();
  await expectNoOverflow(page, "search results");
});

test("the header search dropdown contains long snippets", async ({ page }) => {
  test.skip(LIVE, "depends on what the corpus matches");
  await setupPage(page);
  await page.goto("/app/");
  await page.getByRole("textbox", { name: "Search sessions" }).fill(SEARCH_QUERY);
  await expect(page.getByText("In conversations")).toBeVisible();
  await expectNoOverflow(page, "search dropdown");
});
