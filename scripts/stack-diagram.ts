#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { optimizePng } from "./lib/png";

/**
 * Render, stamp or check the hand-drawn stack diagram (ADR 0035).
 *
 *   bun run diagram:stack           render: draft → docs/assets/architecture-stack{.png,-dark.png}
 *   bun run diagram:stack stamp     record that the draft matches the current architecture.md
 *   bun run diagram:stack check     say whether architecture.md changed since the last stamp
 *   bun run diagram:stack check --ci   the same, as a GitHub Actions warning annotation
 *
 * The diagram is DRAWN, not generated: an agent reads docs/design/architecture.md and
 * edits the draft with the stack-diagram skill (.claude/skills/stack-diagram). Drawing is
 * judgement, so none of it runs in CI. What CI can do is notice that the prose moved and
 * the picture did not: the draft carries a sha256 of architecture.md, and `check`
 * compares it. It never fails a build: a typo fix in the doc is not a reason to redraw,
 * and `stamp` says so explicitly. `topology.test.ts` separately fails if the draft stops
 * naming a component the blueprint has.
 *
 * Every icon is vendored (scripts/stack-diagram/icons.json → brand/icons/), so rendering
 * needs no network: Python 3.9+ for the skill's build.py, and a Playwright Chromium
 * (`bun run test:browser:install`, or point CHROMIUM_PATH at one you have). The PNGs are
 * recompressed losslessly before they are written, since each redraw is committed.
 * The self-contained HTML render goes to the gitignored build/stack-diagram/.
 */

const ROOT = join(import.meta.dir, "..");
const SOURCE = "docs/design/architecture.md";
const DRAFT = join(ROOT, "scripts/stack-diagram/architecture.html");
const ICONS = join(ROOT, "scripts/stack-diagram/icons.json");
const SKILL = join(ROOT, ".claude/skills/stack-diagram");
const HTML_OUT = join(ROOT, "build/stack-diagram/architecture-stack.html");
const PNG_OUT = join(ROOT, "docs/assets/architecture-stack");
const STAMP = /source: docs\/design\/architecture\.md sha256:([0-9a-f]+|pending)/;

const sourceHash = () =>
  createHash("sha256")
    .update(readFileSync(join(ROOT, SOURCE)))
    .digest("hex");

function stamp(): void {
  const draft = readFileSync(DRAFT, "utf8");
  if (!STAMP.test(draft)) throw new Error(`${DRAFT} has no "source: ... sha256:" line`);
  writeFileSync(DRAFT, draft.replace(STAMP, `source: ${SOURCE} sha256:${sourceHash()}`));
  console.log(`stamped the stack diagram draft against ${SOURCE}`);
}

function check(ci: boolean): void {
  const recorded = readFileSync(DRAFT, "utf8").match(STAMP)?.[1];
  if (recorded === sourceHash()) {
    console.log(`stack diagram is in step with ${SOURCE}`);
    return;
  }
  const msg =
    `${SOURCE} changed since the stack diagram was last drawn. If the change affects the ` +
    "picture, redraw it with the stack-diagram skill and run `bun run diagram:stack`; " +
    "if not, run `bun run diagram:stack stamp` (see CLAUDE.md, Stack diagram).";
  console.log(ci ? `::warning file=${SOURCE}::${msg}` : `\n  notice: ${msg}\n`);
}

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

async function render(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "stack-diagram-"));
  try {
    mkdirSync(dirname(HTML_OUT), { recursive: true });
    const icons = join(work, "icons");
    mkdirSync(icons);
    for (const [name, path] of Object.entries(
      JSON.parse(readFileSync(ICONS, "utf8")) as Record<string, string>,
    )) {
      if (name.startsWith("$")) continue;
      if (!path.startsWith("./")) {
        throw new Error(`icons.json: "${name}" must name a vendored file (./brand/icons/...)`);
      }
      let svg = readFileSync(join(ROOT, path), "utf8");
      // A line icon, not a brand mark: tint it to the diagram's ink, as the skill's
      // fetch_icons.py does for the Lucide icons it fetches.
      if (path.startsWith("./brand/icons/lucide/")) {
        svg = svg
          .replace('stroke="currentColor"', 'stroke="#3d4660"')
          .replace('stroke-width="2"', 'stroke-width="1.7"');
      }
      writeFileSync(join(icons, `${name}.svg`), svg);
    }
    run([
      "python3",
      join(SKILL, "scripts/build.py"),
      DRAFT,
      icons,
      HTML_OUT,
      "--fonts",
      join(SKILL, "assets/fonts"),
    ]);

    // The skill's render_png.py does this in Python Playwright; the repo already
    // carries the Node one, so screenshot here rather than ask for a second browser.
    // From the declared @playwright/test, not its transitive `playwright`.
    const { chromium } = await import("@playwright/test");
    // CHROMIUM_PATH: use a Chromium you already have instead of Playwright's pinned build.
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    try {
      for (const theme of ["light", "dark"] as const) {
        // The page picks its theme from prefers-color-scheme, so emulate each one.
        const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: theme });
        await page.goto(`file://${HTML_OUT}`);
        await page.evaluate(() => {
          const s = document.querySelector<HTMLElement>(".scroller");
          if (s) Object.assign(s.style, { border: "none", borderRadius: "0" });
          return document.fonts.ready;
        });
        const path = `${PNG_OUT}${theme === "dark" ? "-dark" : ""}.png`;
        const shot = await page.locator(".canvas").screenshot();
        const png = optimizePng(shot);
        writeFileSync(path, png);
        console.log(
          `wrote ${path.slice(ROOT.length + 1)} (${Math.round(png.length / 1024)} KB, ` +
            `from ${Math.round(shot.length / 1024)} KB)`,
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  stamp();
}

const [cmd = "render", ...rest] = process.argv.slice(2);
if (cmd === "render") await render();
else if (cmd === "stamp") stamp();
else if (cmd === "check") check(rest.includes("--ci"));
else {
  console.error(`unknown command "${cmd}" (render | stamp | check [--ci])`);
  process.exit(1);
}
