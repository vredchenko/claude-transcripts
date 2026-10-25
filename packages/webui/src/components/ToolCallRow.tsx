/**
 * A tool call as one compact row inside an opened fold: the tool, a line of what came
 * back, and whether it worked — opening in place to the full result.
 *
 * The raw rows this replaces showed a call as an `assistant` line naming the tool and
 * its result as a `tool_result` line further down naming nothing, both at full row
 * height. Pairing them is done in `foldRows`; this only draws the pair.
 */
import { Box, Collapse, Stack, Typography, useTheme } from "@mui/material";
import { useState } from "react";
import { MONO } from "../theme";
import { summarizeEntry } from "../transcript-entry";
import type { ToolRow } from "../transcript-timeline";
import { TermHighlight } from "./HighlightedText";
import { useScrollToMatch } from "./TranscriptEntryRow";

export function ToolCallRow({
  row,
  query,
  isFirstMatch,
}: {
  row: ToolRow;
  query?: string;
  /** The row the page scrolls to and opens on arrival from a search result. */
  isFirstMatch: boolean;
}) {
  const theme = useTheme();
  const ref = useScrollToMatch(isFirstMatch);
  const [open, setOpen] = useState(isFirstMatch);
  const result = row.result?.entry;
  const failed = result?.isError === true;
  const preview = result ? summarizeEntry(result).preview : "";

  return (
    <Box
      ref={ref}
      data-testid="tool-call-row"
      sx={{
        borderRadius: 1,
        bgcolor: "background.paper",
        ...(isFirstMatch
          ? { outline: `2px solid ${theme.palette.warning.main}`, outlineOffset: -2 }
          : {}),
      }}
    >
      <Stack
        component="button"
        type="button"
        direction="row"
        spacing={1}
        alignItems="center"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!result}
        sx={{
          width: "100%",
          minWidth: 0,
          px: 1,
          py: 0.5,
          border: 0,
          borderRadius: 1,
          bgcolor: "transparent",
          color: "text.primary",
          cursor: result ? "pointer" : "default",
          textAlign: "left",
          font: "inherit",
          "&:hover": result ? { bgcolor: "action.hover" } : {},
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: MONO, width: 44, flexShrink: 0 }}
        >
          #{row.index}
        </Typography>
        <Typography
          variant="body2"
          sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, flexShrink: 0 }}
        >
          ⚙ {row.name}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {result ? (
            preview ? (
              <TermHighlight text={preview} query={query} />
            ) : (
              <em>(empty result)</em>
            )
          ) : (
            <em>no result recorded</em>
          )}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            flexShrink: 0,
            fontWeight: 600,
            color: !result ? "text.disabled" : failed ? "error.main" : "success.main",
          }}
        >
          {!result ? "…" : failed ? "error" : "ok"}
        </Typography>
        {result && (
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, width: 12 }}>
            {open ? "⌄" : "›"}
          </Typography>
        )}
      </Stack>
      {result && (
        <Collapse in={open} unmountOnExit>
          <Box
            component="pre"
            sx={{
              fontFamily: MONO,
              fontSize: 12,
              m: 0,
              mx: 1,
              mb: 1,
              p: 1.5,
              bgcolor: theme.palette.code.bg,
              border: 1,
              borderColor: failed ? "error.main" : "divider",
              borderRadius: 1,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {result.text ? (
              <TermHighlight text={result.text} query={query} />
            ) : (
              JSON.stringify(result, null, 2)
            )}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}
