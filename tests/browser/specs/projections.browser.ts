/**
 * The three projections of the session list, and the state that selects them.
 *
 * The assertions worth having here are about *interval* handling, because that's what
 * separates a calendar from a list of dots. The corpus holds a session that ran for
 * four days; drawing it on its start date only would look entirely plausible and be
 * wrong, and no amount of "does the calendar render" testing would notice.
 */
import { expect, test } from "@playwright/test";
import { MULTI_DAY_SESSION, NOW, SESSIONS } from "../fixtures/corpus";
import { LIVE, SessionsListPage, setupPage } from "../helpers/app";

/** The corpus's anchor, as the calendar's month and day keys. */
const MONTH = "2026-03";
/** The day the four-day session starts on. */
const SPAN_START_DAY = "2026-03-14";

test.describe("choosing a projection", () => {
  test("defaults to the table", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();
    await expect(list.table).toBeVisible();
  });

  test("the toggle switches projection and records it in the URL", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();

    await list.selectView("Timeline");
    await expect(page).toHaveURL(/view=timeline/);
    await expect(page.getByTestId("timeline-cards")).toBeVisible();

    await list.selectView("Calendar");
    await expect(page).toHaveURL(/view=calendar/);
    await expect(page.getByTestId("calendar-month")).toBeVisible();
  });

  test("a projection URL is linkable", async ({ page }) => {
    // The point of keeping this in the query string: a view can be shared and the
    // back button steps through them.
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=timeline&density=compact");
    await expect(page.getByTestId("timeline-compact")).toBeVisible();
  });

  test("junk in the URL falls back to the default rather than rendering nothing", async ({
    page,
  }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=nonsense&density=nonsense");
    await expect(list.table).toBeVisible();
  });

  test("going back returns to the previous projection", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();
    await list.selectView("Timeline");
    await expect(page.getByTestId("timeline-cards")).toBeVisible();
    await page.goBack();
    await expect(list.table).toBeVisible();
  });
});

test.describe("timeline", () => {
  test("offers all three densities and switches between them", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=timeline");

    await expect(page.getByTestId("timeline-cards")).toBeVisible();
    await list.selectDensity("Compact");
    await expect(page.getByTestId("timeline-compact")).toBeVisible();
    await list.selectDensity("To scale");
    await expect(page.getByTestId("timeline-proportional")).toBeVisible();
    await list.selectDensity("Cards");
    await expect(page.getByTestId("timeline-cards")).toBeVisible();
  });

  test("groups sessions under the day they started", async ({ page }) => {
    test.skip(LIVE, "asserts fixture days");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=timeline");

    // Three sessions share 15 March in the corpus; the heading says so.
    await expect(page.getByText(/Sun, 15 Mar|Sun, Mar 15/)).toBeVisible();
    await expect(page.getByText("3 sessions").first()).toBeVisible();
  });

  test("every session links to its detail page", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=timeline");
    await page.getByTestId("timeline-cards").getByRole("link").first().click();
    await expect(page).toHaveURL(/\/app\/sessions\//);
  });

  test("the proportional density spaces sessions apart", async ({ page }) => {
    test.skip(LIVE, "depends on the corpus's gaps");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=timeline&density=proportional");
    // The corpus has a nine-day gap before its oldest session; to-scale has to make
    // that visibly larger than the gap between two sessions on the same afternoon.
    await expect(page.getByText(/later$/).first()).toBeVisible();
  });
});

test.describe("calendar", () => {
  test("draws a multi-day session across every day it covers", async ({ page }) => {
    test.skip(LIVE, "asserts the fixture's four-day session");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}`);

    // Addressed by href, not by project name: another session in the corpus shares
    // the project, and matching on text would measure whichever came first.
    const bars = page.locator(
      `[data-testid="calendar-bar"][href*="${MULTI_DAY_SESSION.sessionId}"]`,
    );
    // 14–18 March straddles a week boundary, so it is drawn as two bars — which is
    // itself the evidence that spanning works.
    await expect(bars).toHaveCount(2);

    const cellWidth = (await list.calendarDayCells.first().boundingBox())!.width;
    const widths = await bars.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    // Five days covered in total. Placed on its start date alone it would be one.
    const daysCovered = widths.reduce((sum, w) => sum + w / cellWidth, 0);
    expect(daysCovered).toBeGreaterThan(4);
  });

  test("pages between months", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}`);

    await expect(page.getByText("March 2026")).toBeVisible();
    await page.getByRole("button", { name: "next month" }).click();
    await expect(page.getByText("April 2026")).toBeVisible();
    await expect(page).toHaveURL(/month=2026-04/);
    await page.getByRole("button", { name: "previous month" }).click();
    await expect(page.getByText("March 2026")).toBeVisible();
  });

  test("clicking a day opens its hour-by-hour view", async ({ page }) => {
    test.skip(LIVE, "asserts fixture days");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}&day=${SPAN_START_DAY}`);

    await expect(page.getByTestId("calendar-day")).toBeVisible();
    // The four-day session is running on this day, so it must appear in the day grid.
    await expect(list.calendarDayBars.first()).toBeVisible();
    await page.getByRole("button", { name: "Back to month" }).click();
    await expect(page.getByTestId("calendar-month")).toBeVisible();
  });

  test("positions a day's sessions by clock time", async ({ page }) => {
    test.skip(LIVE, "asserts fixture times");
    await setupPage(page);
    const list = new SessionsListPage(page);
    // Three short sessions at different hours of 15 March.
    await list.goto(`?view=calendar&month=${MONTH}&day=2026-03-15`);

    const bars = list.calendarDayBars;
    await expect(bars).not.toHaveCount(0);
    const boxes = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    // Sessions at different times of day must sit at different heights — if they were
    // all placed at the top of the column, the grid would be decorative.
    expect(new Set(boxes.map(Math.round)).size).toBeGreaterThan(1);
  });

  test("says so for a day with nothing on it", async ({ page }) => {
    test.skip(LIVE, "needs a known-empty day");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}&day=2026-03-25`);
    await expect(page.getByText("No sessions on this day.")).toBeVisible();
  });

  test("asks the API only for the month it is showing", async ({ page }) => {
    test.skip(LIVE, "asserts request shape");
    await setupPage(page);
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/sessions?")) requests.push(req.url());
    });
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}`);
    await expect(page.getByTestId("calendar-month")).toBeVisible();

    // A calendar that fetched the whole corpus would work on this fixture and fall
    // over on a real one.
    expect(requests.some((url) => url.includes("from=") && url.includes("to="))).toBe(true);
  });
});

test("a running session is drawn up to now, not to the end of time", async ({ page }) => {
  test.skip(LIVE, "needs the pinned clock");
  await setupPage(page);
  const list = new SessionsListPage(page);
  await list.goto(`?view=calendar&month=${MONTH}`);

  // The corpus's running session started 35 minutes before the anchor. With the clock
  // pinned it occupies part of one day; without pinning it would stretch from the
  // fixture's March to whatever today is and streak across every week row.
  const running = SESSIONS[0]!;
  expect(running.status).toBe("running");
  const bars = list.calendarBars.filter({ hasText: "atlas" });
  await expect(bars.first()).toBeVisible();
  const widths = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  const cellWidth = (await list.calendarDayCells.first().boundingBox())!.width;
  // Every atlas bar fits within a couple of days; none streaks across the month.
  expect(Math.max(...widths)).toBeLessThan(cellWidth * 3);
  expect(new Date(NOW).getUTCFullYear()).toBe(2026);
  expect(MULTI_DAY_SESSION.sessionId).toBeTruthy();
});
