import { createTheme } from "@mui/material";

/**
 * App theme. Deliberately restrained — the roadmap defers a visual rework, so this
 * is a clean, legible **light** baseline (the primary target; a dark variant can
 * follow). Monospace is used for identifiers/paths/transcript content.
 */
export const theme = createTheme({
  palette: {
    mode: "light",
    background: { default: "#f6f8fa", paper: "#ffffff" },
    primary: { main: "#0969da" },
    text: { primary: "#1f2328", secondary: "#57606a" },
  },
  typography: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  components: {
    MuiTableCell: { styleOverrides: { root: { borderColor: "rgba(0,0,0,0.08)" } } },
  },
});

/** Link color used for inline anchors (matches the theme primary). */
export const LINK = "#0969da";

/** Neutral surface for code/JSON blocks on the light theme. */
export const CODE_BG = "#f6f8fa";

/** Monospace stack for ids, paths, and transcript JSON. */
export const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
