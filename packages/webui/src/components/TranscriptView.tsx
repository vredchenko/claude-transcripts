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
import { useState } from "react";
import { useGetSessionTranscript } from "../api/generated";
import { formatCount } from "../format";
import { codeBg, MONO } from "../theme";
import { type EntryView, summarizeEntry } from "../transcript-entry";
import { EmptyState, ErrorState, Loading } from "./states";

const PAGE = 100;

const KIND_COLOR: Record<string, "primary" | "secondary" | "default" | "info"> = {
  user: "info",
  assistant: "primary",
  system: "secondary",
  summary: "default",
};

function EntryRow({ entry, index }: { entry: Record<string, unknown>; index: number }) {
  const view: EntryView = summarizeEntry(entry);
  const theme = useTheme();
  return (
    <Accordion disableGutters square sx={{ bgcolor: "background.paper" }}>
      <AccordionSummary
        expandIcon={<Typography sx={{ fontSize: 18, lineHeight: 1 }}>⌄</Typography>}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ width: "100%", minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, width: 44 }}>
            #{index}
          </Typography>
          <Chip size="small" color={KIND_COLOR[view.kind] ?? "default"} label={view.kind} />
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
            {view.preview || <em>(no text content)</em>}
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
          {JSON.stringify(entry, null, 2)}
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
 */
export function TranscriptView({ sessionId }: { sessionId: string }) {
  const [limit, setLimit] = useState(PAGE);
  const { data, isPending, isError, error, isPlaceholderData } = useGetSessionTranscript(
    sessionId,
    { offset: 0, limit },
    { placeholderData: (prev) => prev },
  );

  if (isPending) return <Loading label="Loading transcript…" />;
  if (isError) return <ErrorState error={error} />;
  if (!data || data.messages.length === 0) {
    return <EmptyState>No transcript stored for this session.</EmptyState>;
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Showing {formatCount(data.messages.length)} of {formatCount(data.totalCount)} entries
      </Typography>
      <Stack spacing={0.5}>
        {data.messages.map((entry, i) => (
          // Transcript order is append-only + stable, so the index is a valid key.
          <EntryRow key={i} entry={entry} index={i} />
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
