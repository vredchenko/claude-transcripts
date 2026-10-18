/**
 * Session export (#226): the detail page's "Export" menu downloads Markdown and opens
 * a print-ready rendering. The formatting itself is unit-tested in
 * `packages/shared/src/session-export.test.ts`; this proves the wiring.
 */
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { MULTI_DAY_SESSION } from "../fixtures/corpus";
import { LIVE, SessionDetailPage, setupPage } from "../helpers/app";

test.describe("session export", () => {
  test.skip(LIVE, "asserts fixture transcript content");

  test("downloads the whole session as Markdown", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    await page.getByRole("button", { name: "Export" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /Markdown/ }).click();
    const file = await download;

    expect(file.suggestedFilename()).toBe(
      `beacon-service-${MULTI_DAY_SESSION.sessionId.slice(0, 8)}.md`,
    );
    const md = await readFile(await file.path(), "utf8");
    expect(md).toContain(`session: "${MULTI_DAY_SESSION.sessionId}"`);
    expect(md).toContain("Can you add a retry policy to the beacon publisher?");
    expect(md).toContain("result (error)");
    expect(md).not.toContain("hook_success");
  });

  test("leaves tool calls out when asked", async ({ page }) => {
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Include tool calls" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /Markdown/ }).click();
    const md = await readFile(await (await download).path(), "utf8");

    expect(md).toContain("bounded exponential backoff");
    expect(md).not.toContain("result ·");
    expect(md).not.toContain("_Tools:");
  });

  test("prints a full rendering of the session", async ({ page }) => {
    // Stand in for the print dialog in every frame, including the export's iframe.
    await page.addInitScript(() => {
      window.print = () => {
        (window.top as unknown as { __printed?: string }).__printed = document.body.innerText;
      };
    });
    await setupPage(page);
    const detail = new SessionDetailPage(page);
    await detail.goto(MULTI_DAY_SESSION.sessionId);

    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: /PDF/ }).click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __printed?: string }).__printed))
      .toContain("Backoff caps at 30s.");
  });
});
