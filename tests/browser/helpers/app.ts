/**
 * Navigation + page objects for the webui.
 *
 * Specs address the app through these rather than through raw selectors, so a MUI
 * upgrade that reshuffles class names is one edit here instead of thirty across the
 * suite. Locators prefer roles and accessible names — the things a user perceives —
 * over `.MuiWhatever-root`, which is an implementation detail that changes without
 * the UI changing at all.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { type MockApiOptions, mockApi } from "./mock-api";

/**
 * Set `E2E_BASE_URL` to an instance's **origin** to run the suite against a real
 * backend instead of the fixtures — e.g. `E2E_BASE_URL=http://127.0.0.1:7650`
 * (no `/app`; that's appended). Assertions about specific fixture content skip
 * themselves in that mode; the layout audits still apply, which is the point —
 * they're how you assess a live UI against real history.
 */
export const LIVE = Boolean(process.env.E2E_BASE_URL);

/** The SPA is served under `/app` in dev and prod alike (Vite `base`). */
export const APP_BASE = "/app";

/**
 * Prepare a page: install the fake webapi (unless running live) and start recording
 * console output for {@link ../helpers/audit.consoleErrors}.
 */
export async function setupPage(page: Page, options: MockApiOptions = {}): Promise<void> {
  if (!LIVE) await mockApi(page, options);
}

/** Navigate and wait for the SPA to have painted its first real content. */
async function go(page: Page, path: string): Promise<void> {
  await page.goto(`${APP_BASE}${path}`);
  // The shell renders immediately; the header title is the first thing that proves
  // React mounted and `/api/model` resolved.
  await expect(page.getByRole("banner")).toBeVisible();
}

export class SessionsListPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await go(this.page, "/");
    await expect(this.page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  }

  /** The sessions table (absent when the list is empty or errored). */
  get table(): Locator {
    return this.page.getByRole("table");
  }

  get rows(): Locator {
    return this.table.locator("tbody tr");
  }

  /** The link in a row's first cell, which carries the shortened session id. */
  rowLink(index: number): Locator {
    return this.rows.nth(index).getByRole("link").first();
  }

  get emptyState(): Locator {
    return this.page.getByText("No sessions recorded yet.");
  }
}

export class SessionDetailPage {
  constructor(readonly page: Page) {}

  async goto(sessionId: string, search = ""): Promise<void> {
    await go(this.page, `/sessions/${sessionId}${search}`);
    await expect(this.page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  }

  /** Every collapsed transcript row (the accordion summaries). */
  get transcriptRows(): Locator {
    return this.page.locator(".MuiAccordionSummary-root");
  }

  get speakerFilter(): Locator {
    return this.page.getByRole("group", { name: "speaker filter" });
  }

  async selectSpeaker(label: "Full" | "You" | "Claude"): Promise<void> {
    await this.speakerFilter.getByRole("button", { name: label }).click();
  }

  get loadMore(): Locator {
    return this.page.getByRole("button", { name: /load more/i });
  }
}

export class SearchResultsPage {
  constructor(readonly page: Page) {}

  async goto(query: string): Promise<void> {
    await go(this.page, `/search?q=${encodeURIComponent(query)}`);
    await expect(this.page.getByRole("heading", { name: /^Results for/ })).toBeVisible();
  }

  /** Type into the header box and press Enter, as a user would. */
  async searchFromHeader(query: string): Promise<void> {
    const box = this.page.getByRole("textbox", { name: "Search sessions" });
    await box.fill(query);
    // The box debounces at 250ms before it will act on Enter.
    await this.page.waitForTimeout(400);
    await box.press("Enter");
  }

  get summaryLine(): Locator {
    return this.page.getByText(/about \d+ session/);
  }

  get sessionResults(): Locator {
    return this.page.getByTestId("search-session-result");
  }

  get turnResults(): Locator {
    return this.page.getByTestId("search-turn-result");
  }

  get emptyState(): Locator {
    return this.page.getByText("No matches for that query.");
  }
}
