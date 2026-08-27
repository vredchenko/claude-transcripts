/**
 * Sessions as intervals on a calendar — now a vertical stack of 24h lanes, one
 * per day. Each day is a row: left cell (day label + session count + active time),
 * right cell (24h lane with session bars positioned by clock time).
 *
 * Month navigation (‹ ›, TODAY) retained. Click a bar to open the session detail.
 */
import {
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "../../api/generated";
import {
  durationSplit,
  formatCount,
  formatDuration,
  formatTimestamp,
  projectName,
  totalTools,
} from "../../format";
import {
  dayKey,
  dayPlacements,
  groupByDay,
  type Interval,
  shiftMonth,
  toInterval,
} from "../../sessions-view";
import { MONO } from "../../theme";

/** Even-hour labels for the axis header. */
const HOUR_LABELS = Array.from({ length: 12 }, (_, i) => i * 2);

/** Stable colour per project via golden-angle-stepped hue hash. */
function projectHue(cwd: string | undefined): number {
  let hash = 0;
  for (const char of cwd ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash * 137.508) % 360;
}

/** Tooltip content for a session bar. */
function sessionTooltip(s: SessionSummary): string {
  return [
    projectName(s.cwd),
    `${s.sessionId.slice(0, 8)} · ${s.cwd}`,
    `Started: ${formatTimestamp(s.startTimestamp ?? s.timestamp)}`,
    `Runtime: ${formatDuration(s.durationMs)}`,
    s.activeMs !== undefined ? `Active: ${formatDuration(s.activeMs)}` : null,
    `Model: ${s.model ?? "—"}`,
    `${formatCount(s.promptCount)} prompts · ${formatCount(totalTools(s.toolCounts))} tools`,
    `Status: ${s.status}`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface Placed {
  session: SessionSummary;
  interval: Interval;
}

/** One day's 24h lane with positioned session bars. */
function DayLane({ dayStart, placed, now }: { dayStart: number; placed: Placed[]; now: number }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const todayKey = dayKey(now);
  const thisKey = dayKey(dayStart);
  const isToday = thisKey === todayKey;

  const date = new Date(dayStart);
  const intervals = placed.map((p) => p.interval);
  const placements = dayPlacements(dayStart, intervals);
  const sessionsOnDay = placed.filter((p) => placements.has(p.interval.sessionId));
  const activeMs = sessionsOnDay.reduce((sum, p) => sum + (p.session.activeMs ?? 0), 0);

  return (
    <Box
      data-testid="calendar-day-lane"
      sx={{
        display: "flex",
        borderBottom: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {/* Day label cell */}
      <Box
        sx={{
          width: 120,
          flexShrink: 0,
          p: 1,
          borderRight: 1,
          borderColor: "divider",
        }}
      >
        <Typography
          variant="body2"
          sx={{
            fontWeight: isToday ? 700 : 400,
            color: isToday ? "primary.main" : "text.primary",
          }}
        >
          {date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {sessionsOnDay.length} session{sessionsOnDay.length === 1 ? "" : "s"}
          {activeMs > 0 && ` · ${formatDuration(activeMs)}`}
        </Typography>
      </Box>

      {/* 24h lane */}
      <Box sx={{ flex: 1, position: "relative", minHeight: 36, minWidth: 0 }}>
        {/* Hour gridlines at even hours */}
        {HOUR_LABELS.map((h) => (
          <Box
            key={h}
            sx={{
              position: "absolute",
              left: `${(h / 24) * 100}%`,
              top: 0,
              bottom: 0,
              borderLeft: 1,
              borderColor: "divider",
              opacity: h === 0 ? 0 : 0.4,
            }}
          />
        ))}

        {/* Session bars */}
        {sessionsOnDay.map(({ session, interval }) => {
          const place = placements.get(interval.sessionId);
          if (!place) return null;
          const hue = projectHue(session.cwd);
          const split = durationSplit(session.durationMs, session.activeMs);
          const activeRatio = split.activePct !== undefined ? split.activePct / 100 : 0.5;
          const opacity = 0.2 + 0.35 * activeRatio;
          // Horizontal positioning: start_hour / 24 for left, runtime_hours / 24 for width.
          const leftPct = place.topPct; // dayPlacements topPct = clock position as %
          const widthPct = Math.max(0.4, place.heightPct); // floored at 0.4%
          const laneHeight = 100 / Math.max(1, place.laneCount);

          return (
            <Tooltip key={session.sessionId} title={sessionTooltip(session)}>
              <Link
                to="/sessions/$id"
                params={{ id: session.sessionId }}
                data-testid="calendar-session-bar"
                style={{
                  position: "absolute",
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  top: `${place.lane * laneHeight}%`,
                  height: `${laneHeight}%`,
                  minHeight: 8,
                  textDecoration: "none",
                }}
              >
                <Box
                  sx={{
                    height: "100%",
                    bgcolor: `hsla(${hue}, ${dark ? "45%, 50%" : "55%, 45%"}, ${opacity})`,
                    borderRadius: 0.5,
                    px: 0.5,
                    fontSize: 10,
                    lineHeight: "18px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: dark ? "#e6edf3" : "#1f2328",
                    "&:hover": { filter: "brightness(1.15)" },
                  }}
                >
                  {widthPct > 3 ? projectName(session.cwd) : ""}
                </Box>
              </Link>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
}

export function SessionsCalendar({
  sessions,
  monthStart,
  daySelected: _daySelected,
  now,
  onMonth,
  onDay: _onDay,
}: {
  sessions: SessionSummary[];
  monthStart: number;
  daySelected?: number;
  now: number;
  onMonth: (monthStart: number) => void;
  onDay: (dayStart: number | undefined) => void;
}) {
  const placed: Placed[] = sessions.map((session) => ({
    session,
    interval: toInterval(session, now),
  }));

  const monthLabel = new Date(monthStart).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  // Group sessions by day for the vertical stack.
  const dayGroups = groupByDay(placed, (p) => p.interval.start);

  return (
    <Box data-testid="calendar-lanes">
      {/* Month navigation */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ mb: 1.5, flexWrap: "wrap", gap: 1 }}
      >
        <IconButton
          size="small"
          aria-label="previous month"
          onClick={() => onMonth(shiftMonth(monthStart, -1))}
        >
          ‹
        </IconButton>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, minWidth: 150 }}>
          {monthLabel}
        </Typography>
        <IconButton
          size="small"
          aria-label="next month"
          onClick={() => onMonth(shiftMonth(monthStart, 1))}
        >
          ›
        </IconButton>
        <Button size="small" onClick={() => onMonth(now)}>
          Today
        </Button>

        {/* Legend */}
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={1} alignItems="center">
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: 0.5,
              bgcolor: "primary.main",
              opacity: 0.55,
            }}
          />
          <Typography variant="caption" color="text.secondary">
            active
          </Typography>
          <Box
            sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: "primary.main", opacity: 0.2 }}
          />
          <Typography variant="caption" color="text.secondary">
            idle
          </Typography>
        </Stack>
      </Stack>

      {/* Hour axis header */}
      <Box sx={{ display: "flex", borderBottom: 2, borderColor: "divider" }}>
        <Box sx={{ width: 120, flexShrink: 0 }} />
        <Box sx={{ flex: 1, position: "relative", height: 20 }}>
          {HOUR_LABELS.map((h) => (
            <Typography
              key={h}
              variant="caption"
              color="text.secondary"
              sx={{
                position: "absolute",
                left: `${(h / 24) * 100}%`,
                transform: "translateX(-50%)",
                fontFamily: MONO,
                fontSize: 10,
              }}
            >
              {String(h).padStart(2, "0")}
            </Typography>
          ))}
        </Box>
      </Box>

      {/* Day rows */}
      <Paper variant="outlined" sx={{ borderTop: 0 }}>
        {dayGroups.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ p: 3, textAlign: "center" }}>
            No sessions this month.
          </Typography>
        ) : (
          dayGroups.map((group) => (
            <DayLane key={group.key} dayStart={group.dayStart} placed={group.items} now={now} />
          ))
        )}
      </Paper>
    </Box>
  );
}
