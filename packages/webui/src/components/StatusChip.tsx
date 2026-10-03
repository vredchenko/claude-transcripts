import { Box, Stack, Tooltip, Typography } from "@mui/material";
import type { SessionStatus } from "../api/generated";
import { clockTime, formatTimestamp, type StatusTime } from "../format";

/**
 * Human labels for the derived lifecycle. `incomplete` reads as "abandoned" — a
 * session that started but never wrote a clean SessionEnd and has since gone quiet.
 * Status is re-derived from recent activity on every read, so an "abandoned"
 * session that receives new events flips back to "live" automatically.
 */
const LABEL: Record<SessionStatus, string> = {
  ended: "ended",
  running: "live",
  incomplete: "abandoned",
};

const TITLE: Record<SessionStatus, string> = {
  ended: "Ended cleanly (a SessionEnd summary was written).",
  running: "Live — recent activity, no clean exit yet.",
  incomplete: "Abandoned — started but no clean exit, and no recent activity (assumed crashed).",
};

const COLOR: Record<SessionStatus, string> = {
  ended: "text.secondary",
  running: "success.main",
  incomplete: "warning.main",
};

/**
 * The status glyph. Each status has its own shape as well as its own colour, so they
 * stay distinguishable without colour: a pulsing dot (still recording), a stop square
 * (finished), a hollow ring (went quiet without finishing).
 */
function StatusGlyph({ status }: { status: SessionStatus }) {
  const color = COLOR[status];
  if (status === "running") {
    return (
      <Box
        component="span"
        sx={{
          position: "relative",
          width: 8,
          height: 8,
          borderRadius: "50%",
          bgcolor: color,
          flexShrink: 0,
          "&::after": {
            content: '""',
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            bgcolor: color,
            animation: "ct-status-pulse 1.8s ease-out infinite",
          },
          "@keyframes ct-status-pulse": {
            "0%": { transform: "scale(1)", opacity: 0.7 },
            "100%": { transform: "scale(2.6)", opacity: 0 },
          },
          "@media (prefers-reduced-motion: reduce)": { "&::after": { animation: "none" } },
        }}
      />
    );
  }
  return (
    <Box
      component="span"
      sx={{
        width: 8,
        height: 8,
        flexShrink: 0,
        borderRadius: status === "ended" ? "2px" : "50%",
        bgcolor: status === "ended" ? color : "transparent",
        border: status === "ended" ? 0 : 1.5,
        borderColor: color,
      }}
    />
  );
}

/**
 * Session lifecycle status — a glyph and label, with an explanatory tooltip. Given
 * `at`, a second line says when: the end time of an ended session, the last write of
 * a live or abandoned one. `reference` (the session start) makes that line name the
 * day when it differs.
 */
export function StatusChip({
  status,
  at,
  reference,
}: {
  status: SessionStatus;
  at?: StatusTime;
  reference?: string;
}) {
  const title = at ? `${TITLE[status]} ${at.label}: ${formatTimestamp(at.iso)}` : TITLE[status];
  return (
    <Tooltip title={title}>
      <Box sx={{ display: "inline-block", minWidth: 0 }}>
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <StatusGlyph status={status} />
          <Typography
            variant="body2"
            sx={{ fontSize: 12.5, fontWeight: 600, color: COLOR[status], lineHeight: 1.3 }}
          >
            {LABEL[status]}
          </Typography>
        </Stack>
        {at && (
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: "block", fontSize: 10.5, pl: "14px" }}
          >
            {at.label} {clockTime(at.iso, reference)}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
}
