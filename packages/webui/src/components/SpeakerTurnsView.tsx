import { Box, Chip, Stack, Typography } from "@mui/material";
import { type SpeakerRole, useGetSessionTurns } from "../api/generated";
import { formatCount, formatTimestamp } from "../format";
import { MONO } from "../theme";
import { EmptyState, ErrorState, Loading } from "./states";

/**
 * Speaker-split reader — one side of a session's conversation, from the
 * `speaker_split/by_role` view (`GET /api/sessions/{id}/turns`). Empty for sessions
 * logged without full-content chunks (`couchFullContentChunks`).
 */
export function SpeakerTurnsView({ sessionId, role }: { sessionId: string; role: SpeakerRole }) {
  const { data, isPending, isError, error } = useGetSessionTurns(sessionId, { role });

  if (isPending) return <Loading label="Loading turns…" />;
  if (isError) return <ErrorState error={error} />;
  if (!data || data.turns.length === 0) {
    return (
      <EmptyState>
        No turns to show. Speaker-split needs full-content chunks — sessions logged with
        <code> couchFullContentChunks</code> off have none.
      </EmptyState>
    );
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {formatCount(data.turns.length)} {role} turn{data.turns.length === 1 ? "" : "s"}
        {data.hasMore ? " (truncated)" : ""}
      </Typography>
      <Stack spacing={1}>
        {data.turns.map((turn, i) => (
          // Turns are byte+index ordered and stable, so the index is a valid key.
          <Box
            key={i}
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              p: 1.5,
              bgcolor: "background.paper",
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              {turn.isError && <Chip size="small" color="error" label="error" />}
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                {turn.timestamp ? formatTimestamp(turn.timestamp) : "—"}
              </Typography>
            </Stack>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {turn.text || <em>(no text)</em>}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
