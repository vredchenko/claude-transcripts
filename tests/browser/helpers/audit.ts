/**
 * Reusable UI assessment — the checks worth running against *any* page of the webui,
 * mocked or live.
 *
 * These exist because the layout bugs this app actually grows are not the kind a
 * unit test can see. A transcript row that spills out of its card still renders, still
 * has the right text, and still passes every assertion about content; it is only wrong
 * *geometrically*. So the audits measure geometry and runtime noise:
 *
 * - {@link overflowingElements} — content escaping its container sideways.
 * - {@link watchConsole} — errors and warnings the page logged while rendering.
 *
 * Both are content-agnostic, so they apply equally to a page of fixtures and to a page
 * of somebody's real history. `bun run test:browser:capture` runs them over every route
 * (see `../capture.ts`) as a standing assessment of an instance.
 */
import type { ConsoleMessage, Page } from "@playwright/test";

/** An element whose box escapes the layout container it should sit inside. */
export interface Overflow {
  /** `tag.class-fragment` — enough to find it in the source. */
  selector: string;
  /** First 80 characters of its text, to identify which row/card it is. */
  text: string;
  /** How far past the container's left/right edge it reaches, in CSS pixels. */
  overflowLeft: number;
  overflowRight: number;
  width: number;
}

/**
 * Elements that stick out sideways from the app's content container.
 *
 * Anything inside a deliberately scrollable or clipping ancestor is ignored — a wide
 * table in a `TableContainer` with `overflow-x: auto` is a scroll affordance, not a
 * bug. What's left is content that genuinely escapes its box, which in this app has
 * always meant a flex child missing `min-width: 0`: a `nowrap` line forces the row to
 * its max-content width and the row grows past the card in both directions.
 *
 * `tolerance` absorbs sub-pixel rounding; 2px is comfortably below anything visible.
 */
export async function overflowingElements(page: Page, tolerance = 2): Promise<Overflow[]> {
  return page.evaluate((tol) => {
    const container =
      document.querySelector(".MuiContainer-root") ??
      document.querySelector("main") ??
      document.body;
    const bounds = container.getBoundingClientRect();

    /** True if anything between `el` and the container clips or scrolls horizontally. */
    const isClipped = (el: Element): boolean => {
      let node: Element | null = el.parentElement;
      while (node && node !== container) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
        node = node.parentElement;
      }
      return false;
    };

    /** Escapes `bounds` horizontally by more than the tolerance. */
    const escapes = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return bounds.left - rect.left > tol || rect.right - bounds.right > tol;
    };

    const out: {
      selector: string;
      text: string;
      overflowLeft: number;
      overflowRight: number;
      width: number;
    }[] = [];

    for (const el of Array.from(container.querySelectorAll("*"))) {
      if (!escapes(el) || isClipped(el)) continue;
      // Report the outermost offender only. A blown-out flex row drags every
      // descendant out with it, and eight lines about one row bury the row itself.
      if (el.parentElement && el.parentElement !== container && escapes(el.parentElement)) continue;

      const rect = el.getBoundingClientRect();
      const cls = typeof el.className === "string" ? el.className : "";
      // The first class is the meaningful one (`MuiAccordionSummary-content`); the
      // emotion hash that follows it changes on every build.
      const first = cls.split(/\s+/).filter((c) => c && !c.startsWith("css-"))[0] ?? "";
      out.push({
        selector: first ? `${el.tagName.toLowerCase()}.${first}` : el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
        overflowLeft: Math.round(Math.max(0, bounds.left - rect.left)),
        overflowRight: Math.round(Math.max(0, rect.right - bounds.right)),
        width: Math.round(rect.width),
      });
    }

    return out;
  }, tolerance);
}

/** True when the page itself scrolls sideways — nothing in this app should. */
export async function hasHorizontalPageScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

export interface ConsoleWatcher {
  /** Console `error`s plus uncaught exceptions, in order. */
  errors: () => string[];
  /** Console `warning`s — noisy but useful when assessing, so kept separate. */
  warnings: () => string[];
}

/**
 * Start recording console output. Call before navigating: messages logged during the
 * first render are exactly the ones worth catching.
 *
 * React's dev build repeats a warning per offending element, so identical messages are
 * collapsed — thirty copies of one key warning is one problem.
 */
export function watchConsole(page: Page): ConsoleWatcher {
  const errors: string[] = [];
  const warnings: string[] = [];
  const record = (list: string[], text: string) => {
    if (!list.includes(text)) list.push(text);
  };
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") record(errors, msg.text());
    if (msg.type() === "warning") record(warnings, msg.text());
  });
  page.on("pageerror", (err: Error) => record(errors, `${err.name}: ${err.message}`));
  return { errors: () => [...errors], warnings: () => [...warnings] };
}

/** Human-readable one-liner per overflow, for assertion messages and capture reports. */
export function describeOverflows(items: Overflow[]): string {
  return items
    .map(
      (o) =>
        `${o.selector} (w=${o.width}px, escapes L${o.overflowLeft}/R${o.overflowRight}) — “${o.text}”`,
    )
    .join("\n");
}

/**
 * Switch the app to a colour mode. The toggle lives behind the header's settings
 * menu, and the choice persists to `localStorage`, so this survives navigation.
 */
export async function setColorMode(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.evaluate((m) => window.localStorage.setItem("ct.colorMode", m), mode);
  await page.reload();
}
