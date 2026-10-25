/**
 * The panel under an expanded session row: everything the summary carries that the
 * grid has no room for, without leaving the list.
 *
 * Fields the API doesn't serve yet (git branch, files touched) are shown as
 * placeholders rather than left out, so the panel's shape is the one it will have
 * once they arrive and nobody wonders whether they were forgotten.
 */
import { Box, Button, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { SessionSummary } from "../../api/generated";
import {
  durationSplitLabel,
  formatBytes,
  formatCount,
  formatTimestamp,
  statusTime,
} from "../../format";
import { MONO } from "../../theme";

/** What a not-yet-served field says, and why. */
const NOT_SERVED = "Not recorded yet";
const NOT_SERVED_WHY = "Pending API implementation";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        component="div"
        color="text.disabled"
        sx={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9.5, lineHeight: 1.4 }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        component="div"
        sx={{ fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere" }}
      >
        {children}
      </Typography>
    </Box>
  );
}

function Placeholder() {
  return (
    <Tooltip title={NOT_SERVED_WHY}>
      <Box component="span" sx={{ color: "text.disabled", fontStyle: "italic" }}>
        {NOT_SERVED}
      </Box>
    </Tooltip>
  );
}

export function SessionRowDetails({ s }: { s: SessionSummary }) {
  const navigate = useNavigate();
  const ended = statusTime(s);
  const tools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
  const t = s.tokenUsage;

  return (
    <Box
      data-testid="session-row-details"
      // The row underneath navigates on click; the panel is for reading and copying.
      onClick={(e) => e.stopPropagation()}
      sx={{
        px: 1.5,
        py: 1.5,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.default",
        cursor: "auto",
      }}
    >
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, minmax(0, 1fr))" },
          gap: 1.5,
        }}
      >
        <Field label="Session id">{s.sessionId}</Field>
        <Field label="Directory">{s.cwd}</Field>
        <Field label="Started">{formatTimestamp(s.startTimestamp ?? s.timestamp)}</Field>
        <Field label={ended?.label === "last write" ? "Last write" : "Ended"}>
          {formatTimestamp(ended?.iso)}
          {s.endReason && s.status === "ended" ? ` (${s.endReason})` : ""}
        </Field>
        <Field label="Time">{durationSplitLabel(s.durationMs, s.activeMs)}</Field>
        <Field label="Tokens">
          {t
            ? `${formatCount(t.input)} in · ${formatCount(t.output)} out · ${formatCount(t.cacheCreation)} cache write · ${formatCount(t.cacheRead)} cache read`
            : "—"}
        </Field>
        <Field label="Activity">
          {formatCount(s.promptCount)} turns · {formatCount(s.eventCount)} events
          {t ? ` · ${formatCount(t.messages)} messages` : ""}
          {s.errorCount > 0 ? ` · ${formatCount(s.errorCount)} errors` : ""}
        </Field>
        <Field label="Transcript">
          {s.hasTranscript ? formatBytes(s.transcriptSize) : "not stored"}
          {s.source ? ` · from ${s.source}` : ""}
        </Field>
        <Field label="Git branch">
          <Placeholder />
        </Field>
        <Field label="Files touched">
          <Placeholder />
        </Field>
        <Box sx={{ gridColumn: { xs: "1 / -1", md: "span 2" } }}>
          <Field label="Tools">
            {tools.length === 0 ? (
              "—"
            ) : (
              <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.25 }}>
                {tools.map(([name, count]) => (
                  <Chip
                    key={name}
                    size="small"
                    variant="outlined"
                    label={`${name} ${formatCount(count)}`}
                    sx={{ fontSize: 10, height: 20 }}
                  />
                ))}
              </Stack>
            )}
          </Field>
        </Box>
      </Box>
      <Box sx={{ mt: 1.5 }}>
        <Button
          size="small"
          variant="outlined"
          onClick={() => navigate({ to: "/sessions/$id", params: { id: s.sessionId } })}
        >
          Open session
        </Button>
      </Box>
    </Box>
  );
}
