import { matchesQuery } from "@claude-transcripts/shared";
import { Box, Button, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TranscriptEntry } from "../api/generated";
import { useUserSettings } from "../api/model";
import { formatCount } from "../format";
import { useInfiniteTranscript } from "../hooks/useInfiniteTranscript";
import { useIntersectionObserver } from "../hooks/useIntersectionObserver";
import { buildTimeline, countTurns } from "../transcript-timeline";
import { EmptyState, ErrorState, Loading } from "./states";
import { TranscriptEntryRow } from "./TranscriptEntryRow";
import { TranscriptTimeline } from "./TranscriptTimeline";

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
 * Lazy transcript viewer: pages entries from the webapi and appends them, so a
 * session reads as one continuous transcript rather than a stack of pages.
 *
 * Three things pull the next page, in increasing order of how much the reader had to
 * do to get it:
 *
 * 1. **The scroll sentinel** — the next block starts loading 600px before the reader
 *    reaches the end, so scrolling never stalls on a request.
 * 2. **Background prefetch** — while the tab is visible the reader keeps pulling
 *    ahead even if nobody scrolls, so arriving at a session and immediately hitting
 *    ctrl-F, or jumping to a search match, finds the text already here. Gated on
 *    visibility: a session left open in a background tab shouldn't quietly drag the
 *    whole corpus down.
 * 3. **"Load the rest"** — past `transcriptAutoLoadMax` the reader stops on its own
 *    and says what's left. Nothing here is virtualised yet, so an unbounded loader
 *    would put tens of thousands of entries in the DOM; past that point pulling the
 *    remainder is the reader's explicit choice. (Virtual scrolling is the planned
 *    follow-up that removes the ceiling.)
 *
 * Given a `query` — set when the reader arrived from a search result — it also marks
 * the matching terms and opens and scrolls to the first matching entry. The paging
 * above is what makes that work on a match a thousand entries in; it used to need its
 * own bespoke auto-load loop.
 */
export function TranscriptView({ sessionId, query }: { sessionId: string; query?: string }) {
  const { transcriptAutoLoadMax } = useUserSettings();
  const [mode, setMode] = useState<TranscriptMode>("timeline");
  /** Set by "Load the rest" — lifts the auto-load ceiling for this mount only. */
  const [unbounded, setUnbounded] = useState(false);

  const {
    entries,
    totalCount,
    source,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isPending,
    isError,
    error,
  } = useInfiniteTranscript(sessionId);

  /** May we pull another page without being asked? */
  const mayAutoLoad =
    hasNextPage === true &&
    !isFetchingNextPage &&
    (unbounded || entries.length < transcriptAutoLoadMax);

  const sentinelRef = useIntersectionObserver(() => fetchNextPage(), mayAutoLoad);

  // Background prefetch. One page per effect run: the fetch flips
  // `isFetchingNextPage`, which closes `mayAutoLoad`, and settling re-opens it — so
  // this walks forward a page at a time rather than firing a burst of requests.
  //
  // A hidden tab doesn't prefetch, and the listener is what lets it pick up again when
  // the reader comes back: without it, a session opened in a background tab would sit
  // on its first page until something else re-rendered the view.
  useEffect(() => {
    if (!mayAutoLoad) return;
    const pull = () => {
      if (document.visibilityState !== "hidden") fetchNextPage();
    };
    pull();
    document.addEventListener("visibilitychange", pull);
    return () => document.removeEventListener("visibilitychange", pull);
  }, [mayAutoLoad, fetchNextPage]);

  /** Index of the first entry containing the query, or -1. */
  const firstMatch = useMemo(() => {
    if (!query) return -1;
    return entries.findIndex((entry) => entryMatches(entry, query));
  }, [entries, query]);

  const nodes = useMemo(() => buildTimeline(entries), [entries]);

  const loadRest = useCallback(() => {
    setUnbounded(true);
    fetchNextPage();
  }, [fetchNextPage]);

  if (isPending) return <Loading label="Loading transcript…" />;
  if (isError) return <ErrorState error={error} />;
  if (entries.length === 0) {
    return <EmptyState>No transcript stored for this session.</EmptyState>;
  }

  /**
   * What to say when the reader arrived from a search hit and we haven't reached it.
   *
   * "searching…" is only honest while pages are still coming; once the auto-load
   * ceiling stops us the match may well be further in, and saying there is none would
   * be wrong — the button below says how to keep looking.
   */
  const searchStatus =
    isFetchingNextPage || mayAutoLoad
      ? " · searching…"
      : hasNextPage
        ? " · no match yet — load the rest to keep looking"
        : " · no match in this transcript";

  const turns = countTurns(nodes);
  const folded = entries.length - turns;
  const remaining = Math.max(totalCount - entries.length, 0);
  /** Stopped short of the end because the ceiling was reached, not because we're done. */
  const capped = hasNextPage === true && !mayAutoLoad && !isFetchingNextPage;

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
            : `Showing ${formatCount(entries.length)} of ${formatCount(totalCount)} entries`}
          {/* Which store answered: `chunks` means this is readable mid-session and will
              keep growing; `s3` means the session's finalised transcript. */}
          {source === "chunks" ? " · live from chunks" : " · from stored transcript"}
          {query && firstMatch === -1 && searchStatus}
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
          {entries.map((entry, i) => (
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

      {/* Sentinel for infinite scroll — kept ahead of the status line so the reader
          reaches it a little before the actual end of the entries. */}
      <div ref={sentinelRef} style={{ height: 1 }} />

      {isFetchingNextPage && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", textAlign: "center", py: 2 }}
        >
          Loading more entries…
        </Typography>
      )}

      {capped && (
        <Box sx={{ textAlign: "center", mt: 2 }}>
          <Button variant="outlined" onClick={loadRest}>
            Load the remaining {formatCount(remaining)} entr{remaining === 1 ? "y" : "ies"}
          </Button>
        </Box>
      )}
    </Box>
  );
}
