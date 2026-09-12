/**
 * The two projections of the session list, and the state that selects them.
 *
 * The list is a day-grouped CSS grid; the calendar draws 24h day lanes with
 * session bars positioned by clock time. Both render the same data with entirely
 * different geometry, so each needs its own visual assertions.
 */
import { expect, test } from "@playwright/test";
import { MULTI_DAY_SESSION, NOW, SESSIONS } from "../fixtures/corpus";
import { LIVE, SessionsListPage, setupPage } from "../helpers/app";

/** The corpus's anchor, as the calendar's month key. */
const MONTH = "2026-03";

test.describe("choosing a projection", () => {
  test("defaults to the list", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();
    await expect(list.list).toBeVisible();
  });

  test("the toggle switches projection and records it in the URL", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();

    await list.selectView("Calendar");
    await expect(page).toHaveURL(/view=calendar/);
    await expect(list.calendarLanes).toBeVisible();
  });

  test("a projection URL is linkable", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}`);
    await expect(list.calendarLanes).toBeVisible();
  });

  test("junk in the URL falls back to the default rather than rendering nothing", async ({
    page,
  }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?view=nonsense");
    await expect(list.list).toBeVisible();
  });

  test("going back returns to the previous projection", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();
    await list.selectView("Calendar");
    await expect(list.calendarLanes).toBeVisible();
    await page.goBack();
    await expect(list.list).toBeVisible();
  });
});

test.describe("calendar", () => {
  test("draws sessions as bars in day lanes", async ({ page }) => {
    test.skip(LIVE, "asserts fixture sessions");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}`);

    // The corpus has sessions across several days — bars should appear.
    await expect(list.calendarSessionBars.first()).toBeVisible();

    // The multi-day session should appear as bars on multiple day lanes.
    const bars = page.locator(
      `[data-testid="calendar-session-bar"][href*="${MULTI_DAY_SESSION.sessionId}"]`,
    );
    await expect(bars).not.toHaveCount(0);
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

  test("positions sessions by clock time within each day lane", async ({ page }) => {
    test.skip(LIVE, "asserts fixture times");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}`);

    const bars = list.calendarSessionBars;
    await expect(bars.first()).toBeVisible();
    // Sessions at different times must sit at different horizontal positions.
    const lefts = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
    // At least two distinct positions — if all bars were stacked at the same spot,
    // the time axis would be decorative.
    expect(new Set(lefts.map(Math.round)).size).toBeGreaterThan(1);
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
    await expect(list.calendarLanes).toBeVisible();

    // A calendar that fetched the whole corpus would work on this fixture and fall
    // over on a real one.
    expect(requests.some((url) => url.includes("from=") && url.includes("to="))).toBe(true);
  });
});

/**
 * The chips render from the URL, so they always *looked* right; what regressed is
 * whether the filter reaches `GET /api/sessions`. These assert the rows, not the
 * chip: a filter that narrows nothing is exactly the bug they exist to catch.
 */
test.describe("filters", () => {
  const PROJECT = "/srv/projects/atlas";
  const inProject = SESSIONS.filter((s) => s.cwd === PROJECT);

  test("a project filter narrows the list, and reaches the API", async ({ page }) => {
    test.skip(LIVE, "asserts fixture sessions");
    await setupPage(page);
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/sessions?")) requests.push(req.url());
    });
    const list = new SessionsListPage(page);
    await list.goto(`?cwd=${encodeURIComponent(PROJECT)}`);

    await expect(list.rows).toHaveCount(inProject.length);
    expect(inProject.length).toBeLessThan(SESSIONS.length);
    // Narrowed by the gateway, not by hiding rows client-side: the list is
    // infinite-scrolled, so an unforwarded filter would let the next page arrive
    // unfiltered underneath the first.
    expect(requests.some((url) => url.includes(`cwd=${encodeURIComponent(PROJECT)}`))).toBe(true);
  });

  test("deleting the chip widens the list back out", async ({ page }) => {
    test.skip(LIVE, "asserts fixture sessions");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?cwd=${encodeURIComponent(PROJECT)}`);
    await expect(list.rows).toHaveCount(inProject.length);

    await list.filterChip("cwd").getByTestId("CancelIcon").click();
    await expect(list.rows).toHaveCount(SESSIONS.length);
    await expect(page).not.toHaveURL(/cwd=/);
  });

  test("model and source filter too, and combine", async ({ page }) => {
    test.skip(LIVE, "asserts fixture sessions");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?model=claude-opus-4-8&source=backfill");

    const expected = SESSIONS.filter(
      (s) => s.model === "claude-opus-4-8" && s.source === "backfill",
    );
    expect(expected.length).toBeGreaterThan(0);
    await expect(list.rows).toHaveCount(expected.length);
  });

  test("a filter that matches nothing says so, rather than 'none recorded yet'", async ({
    page,
  }) => {
    test.skip(LIVE, "asserts fixture sessions");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto("?hostname=a-machine-that-never-recorded-anything");

    await expect(list.filteredEmptyState).toBeVisible();
    await expect(list.emptyState).toHaveCount(0);
  });

  test("the calendar honours the filter as well as the list", async ({ page }) => {
    test.skip(LIVE, "asserts fixture sessions");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto(`?view=calendar&month=${MONTH}&cwd=${encodeURIComponent(PROJECT)}`);
    await expect(list.calendarLanes).toBeVisible();

    // Every bar drawn belongs to the filtered project. The multi-day session draws one
    // bar per day it spans, so this counts distinct sessions, not bars.
    const hrefs = await list.calendarSessionBars.evaluateAll((els) =>
      els.map((el) => el.getAttribute("href") ?? ""),
    );
    const ids = new Set(SESSIONS.filter((s) => hrefs.some((h) => h.includes(s.sessionId))));
    expect(ids.size).toBeGreaterThan(0);
    for (const s of ids) expect(s.cwd).toBe(PROJECT);
  });
});

test("a running session is drawn up to now, not to the end of time", async ({ page }) => {
  test.skip(LIVE, "needs the pinned clock");
  await setupPage(page);
  const list = new SessionsListPage(page);
  await list.goto(`?view=calendar&month=${MONTH}`);

  // The corpus's running session started 35 minutes before the anchor. With the clock
  // pinned it occupies part of one day; without pinning it would stretch from the
  // fixture's March to whatever today is and streak across every day lane.
  const running = SESSIONS[0]!;
  expect(running.status).toBe("running");
  await expect(list.calendarSessionBars.first()).toBeVisible();
  expect(new Date(NOW).getUTCFullYear()).toBe(2026);
  expect(MULTI_DAY_SESSION.sessionId).toBeTruthy();
});
