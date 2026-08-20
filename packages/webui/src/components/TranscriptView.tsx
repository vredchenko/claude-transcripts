import { matchesQuery } from "@claude-transcripts/shared";
import { Box, Button, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import {
  getGetSessionTranscriptQueryKey,
  type TranscriptEntry,
  useGetSessionTranscript,
} from "../api/generated";
import { formatCount } from "../format";
import { buildTimeline, countTurns } from "../transcript-timeline";
import { EmptyState, ErrorState, Loading } from "./states";
import { TranscriptEntryRow } from "./TranscriptEntryRow";
import { TranscriptTimeline } from "./TranscriptTimeline";

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

/**
 * Which reader is on screen.
 *
 * `timeline` is the default because it answers the question people open a session
 * with — what was said — and the stored lines mostly don't. `raw` is every line in
 * order, which is what you want when you're debugging the recording rather than
 * reading the session.
 */
type TranscriptMode = "timeline" | "raw";

/** Does this entry's text contain the query? Drives highlighting and auto-scroll. */
function entryMatches(entry: TranscriptEntry, query: string | undefined): boolean {
  return Boolean(query) && matchesQuery(entry.text ?? "", query ?? "");
}

/**
 * Lazy transcript viewer: pages entries from the webapi in blocks of {@link PAGE},
 * accumulating them so "Load more" appends without refetching earlier pages.
 * (Virtual scrolling is a planned follow-up; incremental paging keeps very long
 * transcripts responsive.)
 *
 * Two readers over the same page of entries: a conversation timeline that folds
 * everything that isn't dialogue into openable runs, and the raw line-by-line list.
 *
 * Given a `query` — set when the reader arrived from a search result — it also marks
 * the matching terms, opens and scrolls to the first matching entry, and keeps paging
 * forward on its own until it finds one (up to {@link MAX_AUTO_LOAD}).
 */
export function TranscriptView({ sessionId, query }: { sessionId: string; query?: string }) {
  const [limit, setLimit] = useState(PAGE);
  const [mode, setMode] = useState<TranscriptMode>("timeline");
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

  const nodes = useMemo(() => buildTimeline(entries ?? []), [entries]);

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

  const turns = countTurns(nodes);
  const folded = data.entries.length - turns;

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1, flexWrap: "wrap", gap: 1 }}
      >
        <Typography variant="body2" color="text.secondary">
          {mode === "timeline"
            ? `${formatCount(turns)} turn${turns === 1 ? "" : "s"} · ${formatCount(folded)} line${
                folded === 1 ? "" : "s"
              } folded`
            : `Showing ${formatCount(data.entries.length)} of ${formatCount(data.totalCount)} entries`}
          {/* Which store answered: `chunks` means this is readable mid-session and will
              keep growing; `s3` means the session's finalised transcript. */}
          {data.source === "chunks" ? " · live from chunks" : " · from stored transcript"}
          {query &&
            firstMatch === -1 &&
            (searching ? " · searching…" : " · no match in these entries")}
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_e, v: TranscriptMode | null) => v && setMode(v)}
          aria-label="transcript reader"
        >
          <ToggleButton value="timeline">Timeline</ToggleButton>
          <ToggleButton value="raw">Raw</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {mode === "timeline" ? (
        <TranscriptTimeline nodes={nodes} query={query} firstMatch={firstMatch} />
      ) : (
        <Stack spacing={0.5} data-testid="transcript-raw">
          {data.entries.map((entry, i) => (
            // Transcript order is append-only + stable, so the index is a valid key.
            <TranscriptEntryRow
              key={i}
              entry={entry}
              index={i}
              query={query}
              isFirstMatch={i === firstMatch}
            />
          ))}
        </Stack>
      )}

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
