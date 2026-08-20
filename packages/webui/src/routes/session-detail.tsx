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
import {
  durationSplit,
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
} from "../format";
import { MONO } from "../theme";

type SpeakerFilter = "all" | "user" | "assistant";

/** Query-string state this route owns. */
export interface SessionDetailSearch {
  /** Search terms that led here, marked in the transcript. See `router.tsx`. */
  q?: string;
}

/**
 * One labelled fact in the metadata grid.
 *
 * The label is a block with a fixed line box and the value sits on its own line, so
 * every cell in a grid row starts its value at the same height. Previously the label
 * was inline and the value's height varied with its content — a chip is taller than a
 * line of text — which left each row's values on slightly different baselines and made
 * a tidy grid read as a jumble.
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        component="div"
        color="text.secondary"
        sx={{
          textTransform: "uppercase",
          letterSpacing: 0.5,
          lineHeight: 1.6,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        component="div"
        sx={{
          // Values are ids, paths and hostnames: they must wrap inside their cell
          // rather than widen the column and skew the whole grid.
          overflowWrap: "anywhere",
          minHeight: 24,
          display: "flex",
          alignItems: "center",
        }}
      >
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
  const split = durationSplit(session?.durationMs, session?.activeMs);

  return (
    <Box>
      <Link to="/" style={{ color: theme.palette.primary.main, textDecoration: "none" }}>
        ← All sessions
      </Link>

      {isPending && <Loading label="Loading session…" />}
      {isError && <ErrorState error={error} />}

      {session && (
        <>
          <Stack
            direction="row"
            spacing={2}
            alignItems="center"
            sx={{ mt: 1, mb: 2, flexWrap: "wrap", gap: 1 }}
          >
            <Typography
              variant="h5"
              // A session id is 36 unbroken characters and the heading is monospace,
              // which is wider than the narrowest phone.
              sx={{ fontFamily: MONO, overflowWrap: "anywhere", minWidth: 0 }}
            >
              {session.sessionId}
            </Typography>
            <StatusChip status={session.status} />
          </Stack>

          <Paper sx={{ p: 2, mb: 3 }}>
            {/* Auto-fill rather than a fixed 2/4 columns: a fixed count leaves a
                ragged hole wherever the field count isn't a multiple of it, and forces
                a column width that long values (a hostname, a model id) then break out
                of. This packs to whatever the width allows and every column is equal. */}
            <Box
              sx={{
                display: "grid",
                gap: 2,
                gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
              }}
            >
              <Field label="Started">
                {formatTimestamp(session.startTimestamp ?? session.timestamp)}
              </Field>
              <Field label="Total runtime">{formatDuration(session.durationMs)}</Field>
              {/* Active and idle together, because either alone invites the wrong
                  reading: a session left open overnight is three hours of "runtime"
                  and twenty minutes of work. */}
              <Field label="Active time">{formatDuration(split.activeMs)}</Field>
              <Field label="Idle time">{formatDuration(split.idleMs)}</Field>
              <Field label="Model">{session.model ?? "—"}</Field>
              <Field label="Hostname">{session.hostname || "—"}</Field>
              <Field label="Recording">
                <SourceChip source={session.source} />
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
