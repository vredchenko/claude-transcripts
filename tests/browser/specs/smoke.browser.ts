/**
 * Does each route render what it promises?
 *
 * Deliberately shallow. These are the assertions that catch a route that stopped
 * mounting, a query key that stopped resolving, or an empty/error state that never
 * appears — the failures that make every deeper test meaningless. Rendering *detail*
 * belongs in the spec for the feature that owns it.
 */
import { expect, test } from "@playwright/test";
import { BARE_SESSION, MULTI_DAY_SESSION, SEARCH_QUERY, SESSIONS } from "../fixtures/corpus";
import {
  LIVE,
  SearchResultsPage,
  SessionDetailPage,
  SessionsListPage,
  setupPage,
} from "../helpers/app";
import { watchConsole } from "../helpers/audit";

test.describe("sessions list", () => {
  test("lists sessions with their metadata", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();

    await expect(list.table).toBeVisible();
    await expect(list.rows).not.toHaveCount(0);

    test.skip(LIVE, "row contents are fixture-specific");
    await expect(list.rows).toHaveCount(SESSIONS.length);
    // Newest first — the order the API returns and the list must preserve.
    await expect(list.rowLink(0)).toHaveText(SESSIONS[0]!.sessionId.slice(0, 8));
    await expect(page.getByText(`${SESSIONS.length} total`)).toBeVisible();
  });

  test("shows the empty state when there is no history", async ({ page }) => {
    test.skip(LIVE, "needs a controlled empty corpus");
    await setupPage(page, { empty: true });
    const list = new SessionsListPage(page);
    await list.goto();
    await expect(list.emptyState).toBeVisible();
  });

  test("surfaces a failed read instead of an empty table", async ({ page }) => {
    test.skip(LIVE, "needs an induced failure");
    await setupPage(page, { failSessions: true });
    await page.goto("/app/");
    await expect(page.getByText(/CouchDB unreachable|500/)).toBeVisible();
  });

  test("a row links through to its session", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();
    await list.rowLink(0).click();
    await expect(page).toHaveURL(/\/app\/sessions\//);
    await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  });
});

test.describe("session detail", () => {
  test("renders metadata and the transcript", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    await expect(page.getByRole("heading", { name: MULTI_DAY_SESSION.sessionId })).toBeVisible();
    await expect(page.getByText("Started", { exact: true })).toBeVisible();
    await expect(detail.transcriptRows).not.toHaveCount(0);
  });

  test("a transcript row expands to its full content", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    const row = detail.transcriptRows.filter({ hasText: "retry policy" }).first();
    await row.click();
    await expect(page.getByText(/bounded exponential backoff|retry policy/).first()).toBeVisible();
  });

  test("says so when a session stored no transcript", async ({ page }) => {
    test.skip(LIVE, "fixture-specific session");
    await setupPage(page);
    await page.goto(`/app/sessions/${BARE_SESSION.sessionId}`);
    await expect(page.getByText(/No transcript/i)).toBeVisible();
  });

  test("the speaker filter switches to the split view", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);
    await detail.selectSpeaker("You");
    await expect(page.getByText(/user turns?/)).toBeVisible();
  });

  test("an unknown session id reports not-found rather than hanging", async ({ page }) => {
    await setupPage(page);
    await page.goto("/app/sessions/does-not-exist");
    await expect(page.getByText(/not found|404/i)).toBeVisible();
  });
});

test.describe("search", () => {
  test("the results page renders hits for a query", async ({ page }) => {
    await setupPage(page);
    const search = new SearchResultsPage(page);
    await search.goto(SEARCH_QUERY);
    await expect(search.summaryLine).toBeVisible();
    await expect(page.getByText("In conversations")).toBeVisible();
  });

  test("the header box navigates to the results page", async ({ page }) => {
    await setupPage(page);
    await page.goto("/app/");
    const search = new SearchResultsPage(page);
    await search.searchFromHeader(SEARCH_QUERY);
    await expect(page).toHaveURL(new RegExp(`/app/search\\?q=${SEARCH_QUERY}`));
  });

  test("reports no matches rather than an empty page", async ({ page }) => {
    await setupPage(page);
    const search = new SearchResultsPage(page);
    await search.goto("zzzznotathinginanycorpus");
    await expect(search.emptyState).toBeVisible();
  });

  test("degrades to a notice when search is unconfigured", async ({ page }) => {
    test.skip(LIVE, "needs Meilisearch turned off");
    await setupPage(page, { searchDisabled: true });
    await page.goto(`/app/search?q=${SEARCH_QUERY}`);
    await expect(page.getByText(/Search is unavailable/)).toBeVisible();
  });
});

test("the app renders without logging errors", async ({ page }) => {
  await setupPage(page);
  const console_ = watchConsole(page);
  const list = new SessionsListPage(page);
  await list.goto();
  await list.rowLink(0).click();
  await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  expect(console_.errors(), "the app logged console errors while rendering").toEqual([]);
});
