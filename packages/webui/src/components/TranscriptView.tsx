import { matchesQuery } from "@claude-transcripts/shared";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getGetSessionTranscriptQueryKey,
  type TranscriptEntry,
  useGetSessionTranscript,
} from "../api/generated";
import { formatCount } from "../format";
import { codeBg, MONO } from "../theme";
import { type EntryView, summarizeEntry } from "../transcript-entry";
import { TermHighlight } from "./HighlightedText";
import { EmptyState, ErrorState, Loading } from "./states";

const PAGE = 100;

/**
 * How far the view will page forward on its own looking for a search match.
 *
 * Arriving from a search result and being told "no matches on this page" would be a
 * non-answer — the match is *somewhere*, and the reader would have to click "Load
 * more" until they found it. So the view keeps fetching until it does. Bounded because
 * a transcript can run to tens of thousands of entries and an unbounded auto-loader
 * would happily pull the whole thing into the DOM; past this point the reader is told
 * where it got to and paging goes back to being their choice.
 */
const MAX_AUTO_LOAD = 1_000;

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
function kindColor(kind: string): "primary" | "secondary" | "default" | "info" {
  return KIND_COLOR[kind] ?? KIND_COLOR[kind.split(":")[0] ?? ""] ?? "default";
}

/** Does this entry's text contain the query? Drives highlighting and auto-scroll. */
function entryMatches(entry: TranscriptEntry, query: string | undefined): boolean {
  return Boolean(query) && matchesQuery(entry.text ?? "", query ?? "");
}

function EntryRow({
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
  const ref = useRef<HTMLDivElement | null>(null);

  // Bring the match into view once, on arrival. Not on every render: the reader may
  // have scrolled somewhere else deliberately, and yanking them back would be worse
  // than never having scrolled at all.
  //
  // Smooth only if the reader hasn't asked for less motion. An unrequested smooth
  // scroll through a few thousand transcript rows is a vestibular trigger, and it also
  // means the whole page is still moving for a second after load — during which
  // anything the reader (or a test) clicks lands somewhere other than where they
  // aimed. `auto` jumps straight there.
  useEffect(() => {
    if (!isFirstMatch) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [isFirstMatch]);

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

/**
 * Lazy transcript viewer: pages entries from the webapi in blocks of {@link PAGE},
 * accumulating them so "Load more" appends without refetching earlier pages. Each
 * entry shows a one-line preview and expands to the raw JSON. (Virtual scrolling is
 * a planned follow-up; incremental paging keeps very long transcripts responsive.)
 *
 * Given a `query` — set when the reader arrived from a search result — it also marks
 * the matching terms, opens and scrolls to the first matching entry, and keeps paging
 * forward on its own until it finds one (up to {@link MAX_AUTO_LOAD}).
 */
export function TranscriptView({ sessionId, query }: { sessionId: string; query?: string }) {
  const [limit, setLimit] = useState(PAGE);
  const params = { offset: 0, limit };
  const { data, isPending, isError, error, isPlaceholderData } = useGetSessionTranscript(
    sessionId,
    params,
    {
      query: {
        queryKey: getGetSessionTranscriptQueryKey(sessionId, params),
        placeholderData: (prev) => prev,
      },
    },
  );

  const entries = data?.entries;
  /** Index of the first entry containing the query, or -1. */
  const firstMatch = useMemo(() => {
    if (!query || !entries) return -1;
    return entries.findIndex((entry) => entryMatches(entry, query));
  }, [entries, query]);

  // Keep reaching forward while the match could still be ahead of us.
  const hasMore = data?.hasMore ?? false;
  const searching = Boolean(query) && firstMatch === -1 && hasMore && limit < MAX_AUTO_LOAD;
  useEffect(() => {
    if (!searching || isPlaceholderData) return;
    setLimit((n) => Math.min(n + PAGE, MAX_AUTO_LOAD));
  }, [searching, isPlaceholderData]);

  if (isPending) return <Loading label="Loading transcript…" />;
  if (isError) return <ErrorState error={error} />;
  if (!data || data.entries.length === 0) {
    return <EmptyState>No transcript stored for this session.</EmptyState>;
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Showing {formatCount(data.entries.length)} of {formatCount(data.totalCount)} entries
        {/* Which store answered: `chunks` means this is readable mid-session and will
            keep growing; `s3` means the session's finalised transcript. */}
        {data.source === "chunks" ? " · live from chunks" : " · from stored transcript"}
        {query &&
          firstMatch === -1 &&
          (searching ? " · searching…" : " · no match in these entries")}
      </Typography>
      <Stack spacing={0.5}>
        {data.entries.map((entry, i) => (
          // Transcript order is append-only + stable, so the index is a valid key.
          <EntryRow key={i} entry={entry} index={i} query={query} isFirstMatch={i === firstMatch} />
        ))}
      </Stack>
      {data.hasMore && (
        <Box sx={{ textAlign: "center", mt: 2 }}>
          <Button
            variant="outlined"
            disabled={isPlaceholderData}
            onClick={() => setLimit((n) => n + PAGE)}
          >
            {isPlaceholderData ? "Loading…" : "Load more"}
          </Button>
        </Box>
      )}
    </Box>
  );
}
