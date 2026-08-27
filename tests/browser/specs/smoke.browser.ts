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

    await expect(list.list).toBeVisible();
    await expect(list.rows).not.toHaveCount(0);

    test.skip(LIVE, "row contents are fixture-specific");
    await expect(list.rows).toHaveCount(SESSIONS.length);
    // Newest first — the first row is today's session, shown by project name.
    await expect(list.rows.first()).toContainText("atlas");
    await expect(page.getByText(`${SESSIONS.length} sessions`)).toBeVisible();
  });

  test("names the machine each session ran on", async ({ page }) => {
    test.skip(LIVE, "asserts fixture values");
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();

    // Two hosts in the corpus — both must appear somewhere in the list. Day grouping
    // reorders rows, so we check the page rather than positional indices.
    await expect(page.getByText(SESSIONS[0]!.hostname).first()).toBeVisible();
    await expect(page.getByText(SESSIONS[2]!.hostname).first()).toBeVisible();
  });

  test("shows the empty state when there is no history", async ({ page }) => {
    test.skip(LIVE, "needs a controlled empty corpus");
    await setupPage(page, { empty: true });
    const list = new SessionsListPage(page);
    await list.goto();
    await expect(list.emptyState).toBeVisible();
  });

  test("surfaces a failed read instead of an empty list", async ({ page }) => {
    test.skip(LIVE, "needs an induced failure");
    await setupPage(page, { failSessions: true });
    await page.goto("/app/");
    await expect(page.getByText(/CouchDB unreachable|500/)).toBeVisible();
  });

  test("a row links through to its session", async ({ page }) => {
    await setupPage(page);
    const list = new SessionsListPage(page);
    await list.goto();
    await list.clickRow(0);
    await expect(page).toHaveURL(/\/app\/sessions\//);
    await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  });
});

test.describe("session detail", () => {
  test("renders metadata and the transcript", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    await expect(page.getByText(MULTI_DAY_SESSION.sessionId.slice(0, 8))).toBeVisible();
    await expect(page.getByText("STARTED")).toBeVisible();
    // The page opens on the conversation, not on the stored lines.
    await expect(detail.turnCards).not.toHaveCount(0);
  });

  test("the timeline shows dialogue and folds the machinery away", async ({ page }) => {
    test.skip(LIVE, "fixture-specific transcript");
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    // Prose from both speakers is on the page as text, not behind a disclosure.
    await expect(page.getByText(/bounded exponential backoff/)).toBeVisible();
    await expect(page.getByText(/Can you add a retry policy/)).toBeVisible();
    // ...and the tool results between them are not.
    await expect(page.getByText(/publisher.ts:44/)).toHaveCount(0);
    await expect(detail.folds).not.toHaveCount(0);
  });

  test("a folded run opens in place to the lines it stands for", async ({ page }) => {
    test.skip(LIVE, "fixture-specific transcript");
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    const fold = detail.folds.filter({ hasText: "tool_result" }).first();
    await fold.click();
    const row = detail.transcriptRows.filter({ hasText: "publisher.ts:44" }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText(/retry policy not configured/).first()).toBeVisible();
  });

  test("the raw reader shows every stored line", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);
    await detail.selectReader("Raw");

    await expect(detail.transcriptRows).not.toHaveCount(0);
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
  await list.clickRow(0);
  await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  expect(console_.errors(), "the app logged console errors while rendering").toEqual([]);
});
