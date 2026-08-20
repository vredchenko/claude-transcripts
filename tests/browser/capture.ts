/**
 * Screenshot + audit every route of a webui instance, and write a report.
 *
 * This is the assessment tool the specs are built out of. The specs answer "did
 * anything break?"; this answers "what does it actually look like, and what is wrong
 * with it right now?" — which is the question you have when you're about to change a
 * layout, and the one a reviewer has when reading the diff.
 *
 *   bun run test:browser:capture                  # fixtures, via the Vite dev server
 *   E2E_BASE_URL=http://127.0.0.1:7650 \
 *     bun run test:browser:capture                # a real instance, real history
 *
 * Output lands in `tests/browser/.captures/` (gitignored): a PNG per route × viewport
 * × colour mode, plus `report.md` listing every overflow and console error found. It
 * is a *report*, not an assertion — nothing fails here, so it stays useful on a UI
 * you already know is broken.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { MULTI_DAY_SESSION, SEARCH_QUERY, SESSIONS } from "./fixtures/corpus";
import {
  describeOverflows,
  hasHorizontalPageScroll,
  overflowingElements,
  watchConsole,
} from "./helpers/audit";
import { mockApi } from "./helpers/mock-api";

const OUT_DIR = join(import.meta.dir, ".captures");
const LIVE_ORIGIN = process.env.E2E_BASE_URL;
const ORIGIN = LIVE_ORIGIN || `http://127.0.0.1:${process.env.WEBUI_PORT || 7651}`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 768, height: 1024 },
] as const;

const MODES = ["light", "dark"] as const;

interface RouteSpec {
  name: string;
  path: string;
  /** Extra interaction before the shot — expanding a row, switching a tab. */
  prepare?: (page: Page) => Promise<void>;
}

/**
 * Live mode can't use fixture session ids, so the route list is built from whatever
 * the instance actually has. Falling back to the fixture id keeps the shape identical
 * in both modes.
 */
async function routes(): Promise<RouteSpec[]> {
  let sessionId = MULTI_DAY_SESSION.sessionId;
  if (LIVE_ORIGIN) {
    try {
      const res = await fetch(`${LIVE_ORIGIN}/api/sessions?limit=50`);
      const body = (await res.json()) as { sessions?: { sessionId: string; eventCount: number }[] };
      // The busiest session is the one most likely to expose a layout problem.
      const busiest = (body.sessions ?? []).sort((a, b) => b.eventCount - a.eventCount)[0];
      if (busiest) sessionId = busiest.sessionId;
    } catch {
      // Instance unreachable — the fixture id will 404 and the report will say so.
    }
  }

  // The month the fixture corpus lives in. Live mode gets whatever month the
  // calendar opens on by default, which is the current one.
  const month = LIVE_ORIGIN ? "" : `&month=${MULTI_DAY_SESSION.startTimestamp.slice(0, 7)}`;

  return [
    { name: "sessions-list", path: "/app/" },
    // The other two projections of the same list. They render entirely different
    // geometry from the table — bars laid across a grid, a spine of cards — so a
    // report that only shot the table would miss most of what can go wrong.
    { name: "sessions-timeline", path: "/app/?view=timeline" },
    { name: "sessions-calendar", path: `/app/?view=calendar${month}` },
    { name: "session-detail", path: `/app/sessions/${sessionId}` },
    {
      name: "session-detail-fold-open",
      path: `/app/sessions/${sessionId}`,
      prepare: async (page) => {
        // The timeline's folded machinery, opened: the state where a run of raw rows
        // has to sit inside the conversation without breaking its layout.
        await page.getByTestId("timeline-fold").first().click();
      },
    },
    {
      name: "session-detail-raw",
      path: `/app/sessions/${sessionId}`,
      prepare: async (page) => {
        await page
          .getByRole("group", { name: "transcript reader" })
          .getByRole("button", { name: "Raw" })
          .click();
        await page.locator(".MuiAccordionSummary-root").first().click();
      },
    },
    {
      name: "session-detail-speaker",
      path: `/app/sessions/${sessionId}`,
      prepare: async (page) => {
        // Scoped to the toggle group: a transcript row is a button too, and one of
        // them contains the word "You" often enough to match by accident.
        await page
          .getByRole("group", { name: "speaker filter" })
          .getByRole("button", { name: "You" })
          .click();
        await page.waitForTimeout(500);
      },
    },
    { name: "search-results", path: `/app/search?q=${encodeURIComponent(SEARCH_QUERY)}` },
  ];
}

interface Finding {
  shot: string;
  overflows: string;
  pageScroll: boolean;
  errors: string[];
  warnings: string[];
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const specs = await routes();
  const browser = await chromium.launch();
  const findings: Finding[] = [];

  for (const viewport of VIEWPORTS) {
    for (const mode of MODES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: mode,
      });
      // The app reads its stored preference on mount; setting it up front avoids a
      // reload-flash between every shot.
      await context.addInitScript((m) => window.localStorage.setItem("ct.colorMode", m), mode);

      for (const spec of specs) {
        const page = await context.newPage();
        const console_ = watchConsole(page);
        if (!LIVE_ORIGIN) await mockApi(page);

        const shot = `${spec.name}-${viewport.name}-${mode}.png`;
        try {
          await page.goto(`${ORIGIN}${spec.path}`, { waitUntil: "domcontentloaded" });
          // Content arrives via react-query; give it a beat to settle rather than
          // racing the first paint.
          await page.waitForLoadState("networkidle").catch(() => {});
          await spec.prepare?.(page);
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(OUT_DIR, shot), fullPage: true });

          findings.push({
            shot,
            overflows: describeOverflows(await overflowingElements(page)),
            pageScroll: await hasHorizontalPageScroll(page),
            errors: console_.errors(),
            warnings: console_.warnings(),
          });
        } catch (err) {
          findings.push({
            shot,
            overflows: "",
            pageScroll: false,
            errors: [`capture failed: ${err instanceof Error ? err.message : String(err)}`],
            warnings: [],
          });
        }
        await page.close();
      }
      await context.close();
    }
  }
  await browser.close();

  const clean = findings.filter(
    (f) => !f.overflows && !f.pageScroll && f.errors.length === 0 && f.warnings.length === 0,
  );
  const report = [
    "# webui capture report",
    "",
    `Source: ${LIVE_ORIGIN ? `live instance at ${LIVE_ORIGIN}` : "synthetic fixtures"}`,
    `Captured: ${findings.length} views · ${clean.length} clean · ${findings.length - clean.length} with findings`,
    "",
    ...findings.flatMap((f) => {
      const lines = [`## ${f.shot}`, ""];
      if (f.pageScroll) lines.push("- **page scrolls horizontally**");
      if (f.overflows) {
        lines.push("- **content escapes its container:**", "", "```", f.overflows, "```", "");
      }
      for (const e of f.errors) lines.push(`- console error: \`${e}\``);
      for (const w of f.warnings) lines.push(`- console warning: \`${w}\``);
      if (lines.length === 2) lines.push("_no findings_");
      lines.push("");
      return lines;
    }),
  ].join("\n");

  await writeFile(join(OUT_DIR, "report.md"), report, "utf8");
  console.log(report);
  console.log(`\nScreenshots + report: ${OUT_DIR}`);
  if (!LIVE_ORIGIN) console.log(`Fixture corpus: ${SESSIONS.length} sessions`);
}

await main();
