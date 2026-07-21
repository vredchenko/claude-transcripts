import { Box, Chip, Divider, Paper, Stack, Typography } from "@mui/material";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useGetSession } from "../api/generated";
import { StatusChip } from "../components/StatusChip";
import { ErrorState, Loading } from "../components/states";
import { TokenUsageChips } from "../components/TokenUsageChips";
import { TranscriptView } from "../components/TranscriptView";
import { formatBytes, formatCount, formatTimestamp } from "../format";
import { MONO } from "../theme";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
      >
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ wordBreak: "break-word" }}>
        {children}
      </Typography>
    </Box>
  );
}

/** `/sessions/$id`: session metadata + the transcript viewer. */
export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const { data: session, isPending, isError, error } = useGetSession(id);

  return (
    <Box>
      <Link to="/" style={{ color: "#58a6ff", textDecoration: "none" }}>
        ← All sessions
      </Link>

      {isPending && <Loading label="Loading session…" />}
      {isError && <ErrorState error={error} />}

      {session && (
        <>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1, mb: 2 }}>
            <Typography variant="h5" sx={{ fontFamily: MONO }}>
              {session.sessionId}
            </Typography>
            <StatusChip status={session.status} />
          </Stack>

          <Paper sx={{ p: 2, mb: 3 }}>
            <Box
              sx={{
                display: "grid",
                gap: 2,
                gridTemplateColumns: { xs: "repeat(2, 1fr)", md: "repeat(4, 1fr)" },
              }}
            >
              <Field label="Started">{formatTimestamp(session.timestamp)}</Field>
              <Field label="Model">{session.model ?? "—"}</Field>
              <Field label="Hostname">{session.hostname || "—"}</Field>
              <Field label="End reason">{session.endReason}</Field>
              <Field label="Prompts">{formatCount(session.promptCount)}</Field>
              <Field label="Events">{formatCount(session.eventCount)}</Field>
              <Field label="Errors">{formatCount(session.errorCount)}</Field>
              <Field label="Transcript size">{formatBytes(session.transcriptSize)}</Field>
            </Box>

            <Box sx={{ mt: 2 }}>
              <Field label="Working directory">
                <span style={{ fontFamily: MONO }}>{session.cwd || "—"}</span>
              </Field>
            </Box>

            <Divider sx={{ my: 2 }} />

            <Field label="Token usage">
              <Box sx={{ mt: 0.5 }}>
                <TokenUsageChips usage={session.tokenUsage} />
              </Box>
            </Field>

            {Object.keys(session.toolCounts).length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Field label="Tool calls">
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
                    {Object.entries(session.toolCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([name, count]) => (
                        <Chip
                          key={name}
                          size="small"
                          variant="outlined"
                          label={`${name} ${count}`}
                        />
                      ))}
                  </Box>
                </Field>
              </Box>
            )}
          </Paper>

          <Typography variant="h6" sx={{ mb: 1 }}>
            Transcript
          </Typography>
          {session.hasTranscript ? (
            <TranscriptView sessionId={session.sessionId} />
          ) : (
            <Typography color="text.secondary" variant="body2">
              No transcript was stored for this session.
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
