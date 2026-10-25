/**
 * "Export" on the session detail page: download the session as Markdown, or print it
 * (and so save it as PDF). Fetches the whole transcript on demand — nothing is read
 * until the reader asks.
 */
import {
  Button,
  Checkbox,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
} from "@mui/material";
import { useState } from "react";
import type { SessionSummary } from "../api/generated";
import { downloadMarkdown, exportMeta, fetchFullTranscript, printSession } from "../session-export";

type ExportFormat = "markdown" | "print";

export function ExportMenu({ session }: { session: SessionSummary }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [includeTools, setIncludeTools] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (format: ExportFormat) => {
    setAnchor(null);
    setBusy(true);
    setError(null);
    try {
      const entries = await fetchFullTranscript(session.sessionId);
      const meta = exportMeta(session);
      if (format === "markdown") downloadMarkdown(meta, entries, { includeTools });
      else printSession(meta, entries, { includeTools });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        disabled={busy || !session.hasTranscript}
        color={error ? "error" : "primary"}
        title={error ? `Export failed: ${error}` : undefined}
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="menu"
      >
        {busy ? "Exporting…" : error ? "Export failed — retry" : "Export"}
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => run("markdown")}>
          <ListItemText primary="Markdown" secondary="Download a .md file" />
        </MenuItem>
        <MenuItem onClick={() => run("print")}>
          <ListItemText primary="PDF" secondary="Print, then “Save as PDF”" />
        </MenuItem>
        <Divider />
        <MenuItem
          dense
          role="menuitemcheckbox"
          aria-checked={includeTools}
          onClick={() => setIncludeTools((v) => !v)}
        >
          <ListItemIcon>
            <Checkbox
              edge="start"
              size="small"
              checked={includeTools}
              disableRipple
              tabIndex={-1}
            />
          </ListItemIcon>
          <ListItemText primary="Include tool calls" />
        </MenuItem>
      </Menu>
    </>
  );
}
