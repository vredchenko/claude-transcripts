/**
 * Search results: showing what matched, and taking you to it.
 *
 * The two failures this guards against are the ones that made search results hard to
 * use in the first place. A result that doesn't mark the matched term makes you re-read
 * the snippet to find your own query in it. And a result that drops the query on the
 * way to the session drops you at entry #0 of a five-thousand-entry transcript, with
 * the thing you searched for somewhere below.
 */
import { expect, test } from "@playwright/test";
import {
  MULTI_DAY_SESSION,
  SEARCH_FOLDED_QUERY,
  SEARCH_METADATA_QUERY,
  SEARCH_QUERY,
} from "../fixtures/corpus";
import { LIVE, SearchResultsPage, SessionDetailPage, setupPage } from "../helpers/app";

/** `<mark>` elements, whatever wraps them. */
const marks = (page: import("@playwright/test").Page) => page.locator("mark");

test.describe("results page", () => {
  test("marks the matched term in a conversation snippet", async ({ page }) => {
    await setupPage(page);
    const search = new SearchResultsPage(page);
    await search.goto(SEARCH_QUERY);

    const firstResult = search.turnResults.first();
    await expect(firstResult).toBeVisible();
    const marked = firstResult.locator("mark").first();
    await expect(marked).toBeVisible();
    await expect(marked).toHaveText(new RegExp(SEARCH_QUERY, "i"));
  });

  test("gives each conversation result its project, time and session", async ({ page }) => {
    test.skip(LIVE, "asserts fixture metadata");
    await setupPage(page);
    const search = new SearchResultsPage(page);
    await search.goto(SEARCH_QUERY);

    // Turn results are grouped by session. The session group header has the project
    // name, and each turn result has a timestamp.
    const firstResult = search.turnResults.first();
    await expect(firstResult.getByText(/\d{2}:\d{2}/)).toBeVisible();
    // The session header above the turn should show the project.
    await expect(page.getByText("beacon-service")).toBeVisible();
    await expect(page.getByText(MULTI_DAY_SESSION.sessionId.slice(0, 8))).toBeVisible();
  });

  test("says which field a metadata hit matched on", async ({ page }) => {
    test.skip(LIVE, "depends on what the corpus matches");
    await setupPage(page);
    const search = new SearchResultsPage(page);
    await search.goto(SEARCH_METADATA_QUERY);

    // A session hit is a row of metadata; without this the reader can't tell why it
    // is in the results at all.
    await expect(search.sessionResults.first().getByText(/matched project/)).toBeVisible();
  });

  test("does not render markup in a snippet as markup", async ({ page }) => {
    test.skip(LIVE, "needs the fixture's markup-bearing turn");
    await setupPage(page);
    const search = new SearchResultsPage(page);
    // The corpus turn containing "<local-command-caveat>" — transcripts carry
    // arbitrary markup, and a snippet must show it, not run it.
    await search.goto("local-command-caveat");
    const result = search.turnResults.first();
    await expect(result).toContainText("<local-command-caveat>");
    // If the tag had been parsed there would be an element, not text.
    expect(await page.locator("local-command-caveat").count()).toBe(0);
  });
});

test.describe("following a result into its session", () => {
  test("carries the query, and marks it in the transcript", async ({ page }) => {
    await setupPage(page);
    const search = new SearchResultsPage(page);
    await search.goto(SEARCH_QUERY);

    // Turn results are grouped by session. Click the session group header link
    // to navigate into the session.
    await page
      .getByRole("link", { name: /beacon/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/app/sessions/[^?]+\\?q=${SEARCH_QUERY}`));
    await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
    await expect(marks(page).first()).toBeVisible();
  });

  test("opens the matching entry rather than leaving it collapsed", async ({ page }) => {
    test.skip(LIVE, "fixture-specific transcript");
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId, `?q=${SEARCH_QUERY}`);
    await detail.selectReader("Raw");

    // The row the search led to is expanded on arrival: landing on a collapsed row
    // means the reader still has to hunt for the thing they searched for.
    const expanded = page.locator(".MuiAccordionSummary-root[aria-expanded='true']");
    await expect(expanded).toHaveCount(1);
    await expect(expanded).toContainText(new RegExp(SEARCH_QUERY, "i"));
  });

  test("marks the match in the turn it was said in", async ({ page }) => {
    test.skip(LIVE, "fixture-specific transcript");
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId, `?q=${SEARCH_QUERY}`);

    // The timeline is the default reader, so the match has to be findable there —
    // marked, inside a dialogue turn, without the reader opening anything.
    const marked = detail.turnCards.locator("mark").first();
    await expect(marked).toBeVisible();
    await expect(marked).toHaveText(new RegExp(SEARCH_QUERY, "i"));
  });

  test("opens the fold a match is hiding in", async ({ page }) => {
    test.skip(LIVE, "fixture-specific transcript");
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    // A term that only occurs in a tool result — which the timeline folds away. A fold
    // that stayed shut here would hide the very thing the reader searched for.
    await detail.goto(MULTI_DAY_SESSION.sessionId, `?q=${SEARCH_FOLDED_QUERY}`);

    // Exactly the one fold holding it, opened; the others stay shut.
    await expect(detail.folds.and(page.locator("[aria-expanded='true']"))).toHaveCount(1);
    const expanded = page.locator(".MuiAccordionSummary-root[aria-expanded='true']");
    await expect(expanded).toHaveCount(1);
    await expect(expanded).toContainText(new RegExp(SEARCH_FOLDED_QUERY, "i"));
  });

  test("states why the transcript is highlighted, and can clear it", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId, `?q=${SEARCH_QUERY}`);

    const banner = page.getByText(`matches for "${SEARCH_QUERY}"`);
    await expect(banner).toBeVisible();

    await page.getByTestId("CancelIcon").click();
    await expect(page).not.toHaveURL(/\?q=/);
    await expect(marks(page)).toHaveCount(0);
  });

  test("highlights the speaker-split view too", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId, `?q=${SEARCH_QUERY}`);
    await detail.selectSpeaker("You");
    await expect(page.getByText(/user turns?/)).toBeVisible();
    await expect(marks(page).first()).toBeVisible();
  });

  test("a session opened from the list has nothing highlighted", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);
    await expect(marks(page)).toHaveCount(0);
  });
});
