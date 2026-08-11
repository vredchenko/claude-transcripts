/**
 * Rendering text with the search matches marked.
 *
 * Two sources, one renderer. Snippets from `/api/search` arrive already marked by
 * Meilisearch (which knows about prefixes and typo tolerance, so its marks are the
 * accurate ones); everything else — a transcript reached by clicking a result — never
 * went through the index and has its terms re-found locally. Both go through the same
 * splitters in `@claude-transcripts/shared` and come back as segments, so this
 * component doesn't care which it was given.
 *
 * Everything is rendered as **text**. The marks are private-use delimiters rather than
 * `<em>` precisely so that no part of this path is tempted to set innerHTML: the
 * content is other people's raw session logs, which routinely contain markup.
 */

import { type HighlightSegment, splitByTerms, splitMarkedText } from "@claude-transcripts/shared";
import { Box } from "@mui/material";
import { useMemo } from "react";
import { highlightBg, highlightFg } from "../theme";

function Segments({ segments }: { segments: HighlightSegment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.match ? (
          <Box
            key={i}
            component="mark"
            sx={{
              // `mark` has a UA default background that ignores the theme; both
              // colours are set so the element looks the same in light and dark.
              bgcolor: (theme) => highlightBg(theme.palette.mode),
              color: (theme) => highlightFg(theme.palette.mode),
              // No padding: a match inside a word would otherwise push the rest of
              // the word away and change how the text reads.
              px: 0,
              borderRadius: "2px",
              fontWeight: 600,
            }}
          >
            {segment.text}
          </Box>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * A snippet from the search index, whose matches the server already marked.
 *
 * Inline by design — it renders into whatever `Typography` or list item wraps it,
 * rather than imposing a block of its own.
 */
export function MarkedSnippet({ snippet }: { snippet: string }) {
  const segments = useMemo(() => splitMarkedText(snippet), [snippet]);
  return <Segments segments={segments} />;
}

/**
 * Arbitrary text with a query's terms marked — for content the index never saw.
 *
 * With no query it renders the text unchanged and does no work, so callers can pass a
 * possibly-absent `query` straight through instead of branching.
 */
export function TermHighlight({ text, query }: { text: string; query?: string }) {
  const segments = useMemo(() => (query ? splitByTerms(text, query) : null), [text, query]);
  if (!segments) return <>{text}</>;
  return <Segments segments={segments} />;
}
