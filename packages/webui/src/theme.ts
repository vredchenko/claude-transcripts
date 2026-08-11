import { createTheme } from "@mui/material";

export type ColorMode = "light" | "dark";

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Build the MUI theme for a color mode. Light is the primary target; dark is a
 * parallel palette selected via the header's theme toggle (see color-mode.tsx).
 * Components read semantic tokens (`primary.main`, `divider`, `text.secondary`,
 * `background.paper`) so they adapt to whichever mode is active — avoid hardcoding
 * mode-specific colors in components; use `codeBg(mode)` for code surfaces.
 */
export function createAppTheme(mode: ColorMode) {
  const dark = mode === "dark";
  return createTheme({
    palette: {
      mode,
      background: dark
        ? { default: "#0d1117", paper: "#161b22" }
        : { default: "#f6f8fa", paper: "#ffffff" },
      primary: { main: dark ? "#58a6ff" : "#0969da" },
      text: dark
        ? { primary: "#e6edf3", secondary: "#8b949e" }
        : { primary: "#1f2328", secondary: "#57606a" },
      divider: dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)",
    },
    typography: { fontFamily: FONT_STACK },
    components: {
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)" },
        },
      },
    },
  });
}

/** Neutral surface for code/JSON blocks, per mode. */
export function codeBg(mode: ColorMode): string {
  return mode === "dark" ? "#0d1117" : "#f6f8fa";
}

/**
 * The marker behind a search match. Amber in both modes, because a match has to read
 * as a match at a glance — but muted enough that a snippet with six of them is still
 * a sentence rather than a highlighter accident.
 *
 * The dark value is translucent on purpose: it sits over `background.paper` and over
 * `codeBg` (a raw transcript block), and a solid fill would fight one of them.
 */
export function highlightBg(mode: ColorMode): string {
  return mode === "dark" ? "rgba(210, 153, 34, 0.38)" : "#fff3c4";
}

/** Text colour on {@link highlightBg} — inherits in dark, darkens in light. */
export function highlightFg(mode: ColorMode): string {
  return mode === "dark" ? "inherit" : "#1f2328";
}

/** Monospace stack for ids, paths, and transcript JSON. */
export const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
