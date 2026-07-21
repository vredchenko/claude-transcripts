import { createTheme } from "@mui/material";

/**
 * App theme. Deliberately restrained — the roadmap defers a visual rework, so this
 * is a clean, legible dark baseline (monospace for identifiers/transcript content).
 */
export const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0e1116", paper: "#161b22" },
    primary: { main: "#58a6ff" },
  },
  typography: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  components: {
    MuiTableCell: { styleOverrides: { root: { borderColor: "rgba(255,255,255,0.08)" } } },
  },
});

/** Monospace stack for ids, paths, and transcript JSON. */
export const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
