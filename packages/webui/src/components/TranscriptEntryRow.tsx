/**
 * One raw transcript line: a labelled one-line preview that expands to the full text
 * (or, for a line with no text, its JSON).
 *
 * Shared by the two readers, which is the point of it living here: the timeline uses
 * it inside an opened run of collapsed lines, and the raw view uses it for every line.
 * A reader who opens a fold and one who switched to the raw list are looking at the
 * same rows.
 */
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../api/generated";
import { codeBg, MONO } from "../theme";
import { type EntryView, summarizeEntry } from "../transcript-entry";
import { TermHighlight } from "./HighlightedText";

const KIND_COLOR: Record<string, "primary" | "secondary" | "default" | "info"> = {
  user: "info",
  assistant: "primary",
  system: "secondary",
  tool_result: "default",
};

/**
 * Colour a row by its family, not its exact label. Non-conversation kinds are
 * `<type>:<subtype>` (`system:turn_duration`, `attachment:hook_success`), so match on
 * the part before the colon — otherwise every one of them falls to "default" and the
 * eye can't group them while scrolling.
 */
export function kindColor(kind: string): "primary" | "secondary" | "default" | "info" {
  return KIND_COLOR[kind] ?? KIND_COLOR[kind.split(":")[0] ?? ""] ?? "default";
}

/**
 * Bring a search match into view once, on arrival. Not on every render: the reader may
 * have scrolled somewhere else deliberately, and yanking them back would be worse than
 * never having scrolled at all.
 *
 * Smooth only if the reader hasn't asked for less motion. An unrequested smooth scroll
 * through a few thousand transcript rows is a vestibular trigger, and it also means the
 * whole page is still moving for a second after load — during which anything the reader
 * (or a test) clicks lands somewhere other than where they aimed. `auto` jumps straight
 * there.
 */
export function useScrollToMatch(active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [active]);
  return ref;
}

export function TranscriptEntryRow({
  entry,
  index,
  query,
  isFirstMatch,
}: {
  entry: TranscriptEntry;
  index: number;
  query?: string;
  /** The row the page scrolls to and opens on arrival from a search result. */
  isFirstMatch: boolean;
}) {
  const view: EntryView = summarizeEntry(entry);
  const theme = useTheme();
  const ref = useScrollToMatch(isFirstMatch);

  return (
    <Accordion
      ref={ref}
      disableGutters
      square
      defaultExpanded={isFirstMatch}
      sx={{
        bgcolor: "background.paper",
        // Mark the row the search sent us to, so it's findable again after scrolling
        // away — the highlighted words alone are easy to lose in a long transcript.
        ...(isFirstMatch
          ? { outline: `2px solid ${theme.palette.warning.main}`, outlineOffset: -2 }
          : {}),
      }}
    >
      <AccordionSummary
        expandIcon={<Typography sx={{ fontSize: 18, lineHeight: 1 }}>⌄</Typography>}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ width: "100%", minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, width: 44 }}>
            #{index}
          </Typography>
          <Chip size="small" color={kindColor(view.kind)} label={view.kind} />
          {view.sidechain && <Chip size="small" variant="outlined" label="subagent" />}
          {view.isError && <Chip size="small" color="error" label="error" />}
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {view.preview ? (
              <TermHighlight text={view.preview} query={query} />
            ) : (
              <em>(no text content)</em>
            )}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Box
          component="pre"
          sx={{
            fontFamily: MONO,
            fontSize: 12,
            m: 0,
            p: 1.5,
            bgcolor: codeBg(theme.palette.mode),
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {/* Full text is the payload worth expanding; a tool-only turn has none, so
              fall back to the turn's structured fields. The JSON fallback isn't
              highlighted — matches are found in `text`, and marking substrings of a
              serialised object would light up field names too. */}
          {entry.text ? (
            <TermHighlight text={entry.text} query={query} />
          ) : (
            JSON.stringify(entry, null, 2)
          )}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}
