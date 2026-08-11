import {
  Box,
  Chip,
  Divider,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from "@mui/material";
import { Link, useNavigate, useParams, useSearch as useRouterSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useGetSession } from "../api/generated";
import { SourceChip } from "../components/SourceChip";
import { SpeakerTurnsView } from "../components/SpeakerTurnsView";
import { StatusChip } from "../components/StatusChip";
import { ErrorState, Loading } from "../components/states";
import { TokenUsageChips } from "../components/TokenUsageChips";
import { TranscriptView } from "../components/TranscriptView";
import { formatBytes, formatCount, formatDuration, formatTimestamp } from "../format";
import { MONO } from "../theme";

type SpeakerFilter = "all" | "user" | "assistant";

/** Query-string state this route owns. */
export interface SessionDetailSearch {
  /** Search terms that led here, marked in the transcript. See `router.tsx`. */
  q?: string;
}

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
  const { q } = useRouterSearch({ from: "/sessions/$id" }) as SessionDetailSearch;
  const query = q?.trim() || undefined;
  const { data: session, isPending, isError, error } = useGetSession(id);
  const [speaker, setSpeaker] = useState<SpeakerFilter>("all");
  const navigate = useNavigate();
  const theme = useTheme();

  return (
    <Box>
      <Link to="/" style={{ color: theme.palette.primary.main, textDecoration: "none" }}>
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
              <Field label="Started">
                {formatTimestamp(session.startTimestamp ?? session.timestamp)}
              </Field>
              <Field label="Total runtime">{formatDuration(session.durationMs)}</Field>
              <Field label="Active time">{formatDuration(session.activeMs)}</Field>
              <Field label="Model">{session.model ?? "—"}</Field>
              <Field label="Hostname">{session.hostname || "—"}</Field>
              <Field label="Recording">
                <Box sx={{ mt: 0.25 }}>
                  <SourceChip source={session.source} />
                </Box>
              </Field>
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

          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1, flexWrap: "wrap", gap: 1 }}
          >
            <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: "wrap" }}>
              <Typography variant="h6">Transcript</Typography>
              {/* Arriving from a result, the highlighting needs a stated cause —
                  otherwise it reads as the app having decided some words matter. The
                  chip clears `?q=`, which is the only way back to a plain transcript
                  short of editing the URL. */}
              {query && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={`matches for “${query}”`}
                  onDelete={() => navigate({ to: "/sessions/$id", params: { id }, search: {} })}
                />
              )}
            </Stack>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={speaker}
              onChange={(_e, v: SpeakerFilter | null) => v && setSpeaker(v)}
              aria-label="speaker filter"
            >
              <ToggleButton value="all">Full</ToggleButton>
              <ToggleButton value="user">You</ToggleButton>
              <ToggleButton value="assistant">Claude</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          {speaker !== "all" ? (
            <SpeakerTurnsView sessionId={session.sessionId} role={speaker} query={query} />
          ) : session.hasTranscript ? (
            <TranscriptView sessionId={session.sessionId} query={query} />
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
