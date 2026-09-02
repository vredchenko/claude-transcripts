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
import { NOW } from "../fixtures/corpus";
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
  if (LIVE) return;
  // Pin the browser's clock to the corpus's anchor. The fixtures are deterministic
  // instants, but the app measures against `Date.now()` — so without this a running
  // session (which extends to "now") stretches from the fixture's March to whatever
  // today is, and the calendar draws it as a bar across five months. Fixing the clock
  // makes the app and the fixtures agree about when "now" is, which also settles
  // "today" in the calendar and keeps screenshots stable over time.
  //
  // `setFixedTime` rather than `install`: it changes what the clock *reports* without
  // taking over timers, so the search box's debounce still fires.
  await page.clock.setFixedTime(new Date(NOW));
  await mockApi(page, options);
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

  /** `search` selects a projection, e.g. `?view=calendar&month=2026-03`. */
  async goto(search = ""): Promise<void> {
    await go(this.page, `/${search}`);
    await expect(this.page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  }

  /** Switch projection through the toggle, as a reader would. */
  async selectView(label: "List" | "Calendar"): Promise<void> {
    await this.page
      .getByRole("group", { name: "session view" })
      .getByRole("button", { name: label })
      .click();
  }

  /** The day-grouped session list container (absent when empty or errored). */
  get list(): Locator {
    return this.page.getByTestId("sessions-list");
  }

  /** Session rows in the grid — one per session. */
  get rows(): Locator {
    return this.page.getByTestId("session-row");
  }

  /** Navigate to a session by clicking its row. */
  async clickRow(index: number): Promise<void> {
    await this.rows.nth(index).click();
  }

  /** Session bars in the calendar's 24h day lanes. */
  get calendarSessionBars(): Locator {
    return this.page.getByTestId("calendar-session-bar");
  }

  /** Day lanes in the calendar. */
  get calendarDayLanes(): Locator {
    return this.page.getByTestId("calendar-day-lane");
  }

  /** The calendar container. */
  get calendarLanes(): Locator {
    return this.page.getByTestId("calendar-lanes");
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

  /** The dialogue turns of the timeline reader — what the page opens on. */
  get turnCards(): Locator {
    return this.page.getByTestId("timeline-turn");
  }

  /** The one-line summaries standing in for a run of folded, non-dialogue lines. */
  get folds(): Locator {
    return this.page.getByTestId("timeline-fold");
  }

  get readerToggle(): Locator {
    return this.page.getByRole("group", { name: "transcript reader" });
  }

  /** Switch between the conversation timeline and the raw line-by-line list. */
  async selectReader(label: "Timeline" | "Raw"): Promise<void> {
    await this.readerToggle.getByRole("button", { name: label }).click();
  }

  get speakerFilter(): Locator {
    return this.page.getByRole("group", { name: "speaker filter" });
  }

  async selectSpeaker(label: "Both" | "You" | "Claude"): Promise<void> {
    await this.speakerFilter.getByRole("button", { name: label }).click();
  }

  /**
   * The button that appears once the reader has auto-loaded as far as it will go on
   * its own. There is no "load more" any more — scrolling and background prefetch
   * cover the ordinary case — so this is only present on a transcript longer than
   * `userSettings.transcriptAutoLoadMax`.
   */
  get loadRest(): Locator {
    return this.page.getByRole("button", { name: /load the remaining/i });
  }
}

export class SearchResultsPage {
  constructor(readonly page: Page) {}

  async goto(query: string): Promise<void> {
    await go(this.page, `/search?q=${encodeURIComponent(query)}`);
    await expect(this.page.getByRole("heading", { name: /^Results for/ })).toBeVisible();
  }

  /** Type into the header omnibox and press Shift+Enter to search. */
  async searchFromHeader(query: string): Promise<void> {
    const box = this.page.getByRole("textbox", { name: "Omnibox" });
    await box.fill(query);
    // The box debounces at 150ms before it will act on Enter.
    await this.page.waitForTimeout(300);
    await box.press("Shift+Enter");
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
    return this.page.getByText("No results for that query.");
  }
}
