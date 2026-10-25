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
 * The app's one theme: dark, in the Gruvbox palette (https://github.com/morhetz/gruvbox).
 * There is deliberately no light variant or toggle — a single palette is restyled in
 * place rather than kept in step with a twin.
 * Components read semantic tokens (`primary.main`, `divider`, `text.secondary`,
 * `background.paper`) rather than hardcoding colours, and `theme.palette.code.bg` for
 * code surfaces, so a restyle is a change to this file alone.
 */
export const theme = createTheme({
  palette: {
    mode: "dark",
    // Gruvbox dark: bg0_h for the page, bg0 for surfaces, fg / fg4 for text.
    background: { default: "#1d2021", paper: "#282828" },
    primary: { main: "#8ec07c" }, // aqua
    secondary: { main: "#d3869b" }, // purple
    error: { main: "#fb4934" },
    warning: { main: "#fabd2f" },
    success: { main: "#b8bb26" },
    info: { main: "#83a598" },
    text: { primary: "#ebdbb2", secondary: "#a89984", disabled: "#7c6f64" },
    divider: "rgba(235, 219, 178, 0.12)",
    action: { hover: "rgba(235, 219, 178, 0.06)", selected: "rgba(235, 219, 178, 0.10)" },
    code: { bg: "#1d2021" },
    highlight: { bg: "rgba(250, 189, 47, 0.35)", fg: "inherit" },
    // User in Gruvbox blue; Claude in Gruvbox orange, close to the brand's terracotta.
    speaker: { user: "#83a598", assistant: "#fe8019" },
  },
  typography: { fontFamily: FONT_STACK },
  components: {
    MuiTableCell: {
      styleOverrides: { root: { borderColor: "rgba(235, 219, 178, 0.08)" } },
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
