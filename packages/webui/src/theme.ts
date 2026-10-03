import { createTheme } from "@mui/material";

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Monospace stack for ids, paths, and transcript JSON. */
export const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

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
 * The app's one theme: dark. There is deliberately no light variant or toggle — a
 * single palette is restyled in place rather than kept in step with a twin.
 * Components read semantic tokens (`primary.main`, `divider`, `text.secondary`,
 * `background.paper`) rather than hardcoding colours, and `theme.palette.code.bg` for
 * code surfaces, so a restyle is a change to this file alone.
 */
export const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0d1117", paper: "#161b22" },
    primary: { main: "#58a6ff" },
    text: { primary: "#e6edf3", secondary: "#8b949e" },
    divider: "rgba(255,255,255,0.10)",
    code: { bg: "#0d1117" },
    highlight: { bg: "rgba(210, 153, 34, 0.38)", fg: "inherit" },
    speaker: { user: "#58a6ff", assistant: "#D97757" },
  },
  typography: { fontFamily: FONT_STACK },
  components: {
    MuiTableCell: {
      styleOverrides: { root: { borderColor: "rgba(255,255,255,0.08)" } },
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
