import { createTheme } from "@mui/material";

export type ColorMode = "light" | "dark";

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Monospace stack for ids, paths, and transcript JSON. */
export const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Per-mode palette extensions: code surfaces, search highlights, and speaker
 * accent colours. Keyed by ColorMode so a component can read the resolved value
 * from `theme.palette.code.bg` instead of dispatching on the mode manually.
 */
const PALETTE: Record<
  ColorMode,
  {
    code: { bg: string };
    highlight: { bg: string; fg: string };
    speaker: { user: string; assistant: string };
  }
> = {
  dark: {
    code: { bg: "#0d1117" },
    highlight: { bg: "rgba(210, 153, 34, 0.38)", fg: "inherit" },
    speaker: { user: "#58a6ff", assistant: "#D97757" },
  },
  light: {
    code: { bg: "#f6f8fa" },
    highlight: { bg: "#fff3c4", fg: "#1f2328" },
    speaker: { user: "#0969da", assistant: "#D97757" },
  },
};

// Augment MUI's palette types so `theme.palette.code` etc. typecheck.
declare module "@mui/material/styles" {
  interface Palette {
    code: { bg: string };
    highlight: { bg: string; fg: string };
    speaker: { user: string; assistant: string };
  }
  interface PaletteOptions {
    code?: { bg: string };
    highlight?: { bg: string; fg: string };
    speaker?: { user: string; assistant: string };
  }
}

/**
 * Build the MUI theme for a color mode. Light is the primary target; dark is a
 * parallel palette selected via the header's theme toggle (see color-mode.tsx).
 * Components read semantic tokens (`primary.main`, `divider`, `text.secondary`,
 * `background.paper`) so they adapt to whichever mode is active — avoid hardcoding
 * mode-specific colors in components; use `theme.palette.code.bg` for code surfaces.
 */
export function createAppTheme(mode: ColorMode) {
  const dark = mode === "dark";
  const ext = PALETTE[mode];
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
      code: ext.code,
      highlight: ext.highlight,
      speaker: ext.speaker,
    },
    typography: { fontFamily: FONT_STACK },
    components: {
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)" },
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          /**
           * `.MuiAccordionSummary-content` is a flex container, and a flex item's
           * default `min-width: auto` refuses to shrink below its content's
           * max-content width. A transcript row previews a single unwrapped line, so
           * one long unbroken string — a path, a caveat block, a base64 blob, all of
           * which transcripts are full of — forced the row to seventeen hundred
           * pixels and spilled it out of the card on *both* sides, over neighbouring
           * controls.
           *
           * Fixed here rather than at the one call site because it's a property of
           * the component, not of that row: any accordion added later would inherit
           * the same bug.
           */
          content: { minWidth: 0 },
        },
      },
    },
  });
}
