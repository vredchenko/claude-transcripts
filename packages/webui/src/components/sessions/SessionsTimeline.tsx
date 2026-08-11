/**
 * Sessions as a vertical timeline — the projection that answers "what have I been
 * working on lately", which the table answers only if you read the timestamp column.
 *
 * Three densities, because the question changes with how much history you're looking
 * at. `cards` shows a day's work in detail; `compact` fits a month on a screen;
 * `proportional` positions sessions by real elapsed time, so the *rhythm* is visible —
 * the afternoon of six short sessions looks different from the fortnight of nothing.
 * All three are the same data and the same spine; only the row and its spacing change.
 */
import { Box, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "../../api/generated";
import {
  formatCount,
  formatDuration,
  formatTimestamp,
  projectName,
  totalTools,
} from "../../format";
import { groupByDay, type Interval, proportionalGaps, toInterval } from "../../sessions-view";
import { MONO } from "../../theme";
import { SourceChip } from "../SourceChip";
import { StatusChip } from "../StatusChip";

export type TimelineDensity = "cards" | "compact" | "proportional";

/** Clock time only — the day is already stated by the heading above the row. */
function timeOfDay(iso: string | undefined): string {
  return formatTimestamp(iso).slice(11) || "—";
}

/** The dot on the spine. Colour carries status, so a live session is findable. */
function Marker({ status }: { status: SessionSummary["status"] }) {
  const theme = useTheme();
  const color =
    status === "running"
      ? theme.palette.success.main
      : status === "incomplete"
        ? theme.palette.warning.main
        : theme.palette.primary.main;
  return (
    <Box
      sx={{
        width: 11,
        height: 11,
        borderRadius: "50%",
        bgcolor: color,
        flexShrink: 0,
        mt: 0.5,
        // A ring in the page background separates the dot from the spine it sits on.
        boxShadow: (t) => `0 0 0 3px ${t.palette.background.default}`,
        zIndex: 1,
      }}
    />
  );
}

/** A duration drawn to scale against the longest session on screen. */
function DurationBar({ ms, longestMs }: { ms: number | undefined; longestMs: number }) {
  if (!ms || ms <= 0 || longestMs <= 0) return null;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
      <Box
        sx={{
          height: 4,
          borderRadius: 2,
          bgcolor: "primary.main",
          opacity: 0.55,
          // Square-rooted so a 169-hour session doesn't render every ordinary one as
          // a nub. The bar is for comparison at a glance, not for measurement.
          width: `${Math.max(2, Math.sqrt(ms / longestMs) * 100)}%`,
          maxWidth: 220,
          minWidth: 4,
        }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {formatDuration(ms)}
      </Typography>
    </Box>
  );
}

function SessionLink({ session, bold }: { session: SessionSummary; bold?: boolean }) {
  const theme = useTheme();
  return (
    <Link
      to="/sessions/$id"
      params={{ id: session.sessionId }}
      style={{ color: theme.palette.primary.main, textDecoration: "none", minWidth: 0 }}
    >
      <Typography component="span" sx={{ fontWeight: bold ? 600 : 400, overflowWrap: "anywhere" }}>
        {projectName(session.cwd)}
      </Typography>
    </Link>
  );
}

/** The detailed row: everything the table shows, laid out to be read rather than scanned. */
function CardRow({ session, longestMs }: { session: SessionSummary; longestMs: number }) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "background.paper",
        p: 1.5,
        flex: 1,
        minWidth: 0,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="baseline"
        sx={{ flexWrap: "wrap", gap: 0.5, mb: 0.5 }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
          {timeOfDay(session.startTimestamp ?? session.timestamp)}
        </Typography>
        <SessionLink session={session} bold />
        <StatusChip status={session.status} />
        {/* Only when it isn't live. The table puts status and source in separate
            labelled columns, so "live / live" reads fine there; side by side and
            unlabelled it's just the same word twice. Backfilled is the case actually
            worth flagging. */}
        {session.source && session.source !== "live" && <SourceChip source={session.source} />}
      </Stack>

      <DurationBar ms={session.durationMs} longestMs={longestMs} />

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 0.5, overflowWrap: "anywhere" }}
      >
        {[
          session.model,
          `${formatCount(session.promptCount)} prompt${session.promptCount === 1 ? "" : "s"}`,
          `${formatCount(session.eventCount)} events`,
          `${formatCount(totalTools(session.toolCounts))} tools`,
          session.tokenUsage ? `${formatCount(session.tokenUsage.total)} tokens` : null,
          session.errorCount ? `${formatCount(session.errorCount)} errors` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Typography>
    </Box>
  );
}

/** One line per session: time, project, duration, status. */
function CompactRow({ session }: { session: SessionSummary }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="baseline"
      sx={{ flex: 1, minWidth: 0, py: 0.25, flexWrap: "wrap", gap: 0.5 }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, flexShrink: 0 }}>
        {timeOfDay(session.startTimestamp ?? session.timestamp)}
      </Typography>
      <SessionLink session={session} />
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {formatDuration(session.durationMs)}
      </Typography>
      <Tooltip title={session.cwd || ""}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session.model ?? ""}
        </Typography>
      </Tooltip>
      <StatusChip status={session.status} />
    </Stack>
  );
}

/** The vertical rule the markers sit on. */
const SPINE_SX = {
  position: "relative",
  pl: 3,
  "&::before": {
    content: '""',
    position: "absolute",
    left: 5,
    top: 0,
    bottom: 0,
    width: "2px",
    bgcolor: "divider",
  },
} as const;

function DayHeading({ dayStart, count }: { dayStart: number; count: number }) {
  const date = new Date(dayStart);
  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {date.getFullYear()} · {count} session{count === 1 ? "" : "s"}
      </Typography>
    </Stack>
  );
}

export function SessionsTimeline({
  sessions,
  density,
  now,
}: {
  sessions: SessionSummary[];
  density: TimelineDensity;
  /** Injected so a running session's extent is deterministic under test. */
  now: number;
}) {
  const longestMs = sessions.reduce((max, s) => Math.max(max, s.durationMs ?? 0), 0);

  if (density === "proportional") {
    // Positioned by real elapsed time rather than grouped, because the gaps are the
    // point of this density — grouping by day would erase exactly what it shows.
    const intervals: Interval[] = sessions.map((s) => toInterval(s, now));
    const gaps = proportionalGaps(intervals);
    return (
      <Box sx={SPINE_SX} data-testid="timeline-proportional">
        {sessions.map((session, i) => (
          <Box key={session.sessionId} sx={{ mt: `${gaps[i] ?? 0}px` }}>
            {(gaps[i] ?? 0) > 40 && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 0.5, fontStyle: "italic" }}
              >
                {formatDuration(
                  Math.max(0, (intervals[i - 1]?.start ?? 0) - (intervals[i]?.end ?? 0)),
                )}{" "}
                later
              </Typography>
            )}
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
              <Marker status={session.status} />
              <CompactRow session={session} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ pl: 3 }}>
              {formatTimestamp(session.startTimestamp ?? session.timestamp)}
            </Typography>
          </Box>
        ))}
      </Box>
    );
  }

  const groups = groupByDay(sessions, (s) => Date.parse(s.startTimestamp ?? s.timestamp) || now);

  return (
    <Stack spacing={3} data-testid={`timeline-${density}`}>
      {groups.map((group) => (
        <Box key={group.key}>
          <DayHeading dayStart={group.dayStart} count={group.items.length} />
          <Stack spacing={density === "cards" ? 1 : 0.25} sx={SPINE_SX}>
            {group.items.map((session) => (
              <Stack key={session.sessionId} direction="row" spacing={1.5} alignItems="flex-start">
                <Marker status={session.status} />
                {density === "cards" ? (
                  <CardRow session={session} longestMs={longestMs} />
                ) : (
                  <CompactRow session={session} />
                )}
              </Stack>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
