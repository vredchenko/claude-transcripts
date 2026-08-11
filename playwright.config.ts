/**
 * Playwright config for the webui browser suite (`bun run test:browser`).
 *
 * Two modes, one set of specs:
 *
 * - **Mocked** (default). Playwright starts the Vite dev server and every `/api/**`
 *   call is answered from `tests/browser/fixtures/` — no CouchDB, no Garage, no
 *   Meilisearch, nothing on the machine to set up. This is what runs in CI, and it is
 *   deterministic enough that a screenshot difference means a rendering difference.
 * - **Live**. Set `E2E_BASE_URL` to an instance's origin (e.g.
 *   `E2E_BASE_URL=http://127.0.0.1:7650 bun run test:browser`) and the fixtures step
 *   aside. Fixture-specific assertions skip themselves; the layout and console audits
 *   still run, which is how you assess a real instance against real history.
 *
 * Every spec runs on Chromium and Firefox, at two widths each — see `projects` below
 * for why both engines earn their place.
 */
import { defineConfig, devices } from "@playwright/test";

/** Origin under test. Absent → the Vite dev server this config starts. */
const liveBaseUrl = process.env.E2E_BASE_URL;
const devPort = Number(process.env.WEBUI_PORT || 7651);
const baseURL = liveBaseUrl || `http://127.0.0.1:${devPort}`;

/** A roomy desktop window, and a phone-width one. */
const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 412, height: 915 };

export default defineConfig({
  testDir: "./tests/browser/specs",
  // Not `*.spec.ts`: `bun test` treats that as its own, and the two runners must not
  // collect each other's files. (bunfig.toml also scopes `bun test` to `packages/`.)
  testMatch: /.*\.browser\.ts$/,
  outputDir: "./tests/browser/.results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    // Traces and screenshots only for failures — enough to diagnose a CI-only break
    // without writing a gigabyte per green run.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Bounded well under the test timeout on purpose. A layout bug that shifts an
    // element out from under the pointer makes Playwright retry the click until
    // *something* gives; if that's the test timeout, the failure is reported as a
    // timeout, which `test.fail()` will not accept as the expected failure. Failing
    // the action first turns it into an ordinary error, which it can.
    actionTimeout: 10_000,
  },

  /**
   * Two engines × two widths.
   *
   * Chromium alone would be a poor gate for this app: nearly everything it renders is
   * flexbox and CSS grid, and the layout bugs it grows are about intrinsic sizing —
   * `min-width: auto` on flex items, `max-content` measurement, grid track sizing —
   * which is exactly the area where Gecko and Blink still differ in the details.
   *
   * Both widths, because most of what this suite has caught only existed at the
   * narrow one.
   *
   * Firefox gets a plain narrow viewport rather than a device profile: Playwright's
   * `isMobile`/touch emulation is Chromium-only, and a device descriptor would throw
   * rather than degrade. Width is what the layouts respond to here anyway.
   */
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "firefox-desktop",
      use: { ...devices["Desktop Firefox"], viewport: DESKTOP },
    },
    {
      name: "firefox-mobile",
      use: { ...devices["Desktop Firefox"], viewport: NARROW },
    },
  ],

  // Live mode talks to an instance that is already up; only the mocked mode needs a
  // server, and reusing a dev server you already have running keeps the loop fast.
  webServer: liveBaseUrl
    ? undefined
    : {
        command: "bun --filter @claude-transcripts/webui dev",
        url: `http://127.0.0.1:${devPort}/app/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
