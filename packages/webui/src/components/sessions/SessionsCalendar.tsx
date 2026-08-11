/**
 * Sessions as intervals on a calendar.
 *
 * Two levels, because one can't serve both ends of this data. The **month** grid draws
 * each session as a bar across the days it actually covers — the corpus holds sessions
 * that ran for four days, and a calendar that dots them on their start date is simply
 * wrong about them. The **day** grid is a 24-hour column where a session is positioned
 * and sized by clock time, which is the only way to tell six short sessions in one
 * afternoon apart.
 *
 * All the placement arithmetic lives in `../../sessions-view.ts` and is tested there;
 * this file is layout.
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
import { formatDuration, formatTimestamp, projectName } from "../../format";
import {
  dayKey,
  dayPlacements,
  type Interval,
  monthWeeks,
  overlapsDay,
  shiftMonth,
  toInterval,
  weekBars,
} from "../../sessions-view";
import { MONO } from "../../theme";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Bars taller than this are drawn with their label inside. */
const LABEL_MIN_PCT = 6;

/**
 * A stable colour per project, so the same work is the same colour across every cell
 * and month. Hashed rather than assigned from a list, because the set of projects is
 * whatever the reader happens to have — there's no fixed roster to map.
 */
function projectHue(cwd: string | undefined): number {
  let hash = 0;
  for (const char of cwd ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  // Golden-angle steps spread neighbouring hashes to distant hues, so two projects
  // rarely land on near-identical colours.
  return Math.abs(hash * 137.508) % 360;
}

function barColors(cwd: string | undefined, dark: boolean) {
  const hue = projectHue(cwd);
  return {
    bg: `hsl(${hue} ${dark ? "45% 32%" : "70% 88%"})`,
    border: `hsl(${hue} ${dark ? "50% 48%" : "55% 65%"})`,
    text: dark ? "#e6edf3" : "#1f2328",
  };
}

interface Placed {
  session: SessionSummary;
  interval: Interval;
}

function sessionTitle(session: SessionSummary): string {
  return [
    projectName(session.cwd),
    formatTimestamp(session.startTimestamp ?? session.timestamp),
    formatDuration(session.durationMs),
    session.model,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The month grid: six week rows, each session a bar spanning the days it covers. */
function MonthGrid({
  monthStart,
  placed,
  now,
  onPickDay,
}: {
  monthStart: number;
  placed: Placed[];
  now: number;
  onPickDay: (dayStart: number) => void;
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const weeks = monthWeeks(monthStart);
  const thisMonth = new Date(monthStart).getMonth();
  // From the caller's fixed `now`, so the highlighted day matches the one every
  // other part of this render measured against.
  const todayKey = dayKey(now);
  const byId = new Map(placed.map((p) => [p.session.sessionId, p.session]));

  return (
    <Paper variant="outlined" data-testid="calendar-month">
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {WEEKDAYS.map((label) => (
          <Typography
            key={label}
            variant="caption"
            color="text.secondary"
            sx={{ p: 0.5, textAlign: "center", borderBottom: 1, borderColor: "divider" }}
          >
            {label}
          </Typography>
        ))}
      </Box>

      {weeks.map((week) => {
        const bars = weekBars(
          week,
          placed.map((p) => p.interval),
        );
        const lanes = Math.max(1, ...bars.map((b) => b.lane + 1));
        return (
          <Box key={week[0]} sx={{ position: "relative", borderBottom: 1, borderColor: "divider" }}>
            {/* Day cells: the backdrop, and the click targets. */}
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
              {week.map((day) => {
                const outside = new Date(day).getMonth() !== thisMonth;
                const isToday = dayKey(day) === todayKey;
                return (
                  <Box
                    key={day}
                    onClick={() => onPickDay(day)}
                    data-testid="calendar-day-cell"
                    sx={{
                      // Room for the day number plus every lane of bars, so a busy
                      // week grows its row instead of clipping.
                      minHeight: 34 + lanes * 20,
                      borderRight: 1,
                      borderColor: "divider",
                      p: 0.5,
                      cursor: "pointer",
                      opacity: outside ? 0.45 : 1,
                      "&:hover": { bgcolor: "action.hover" },
                      "&:last-of-type": { borderRight: 0 },
                    }}
                  >
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: MONO,
                        fontWeight: isToday ? 700 : 400,
                        color: isToday ? "primary.main" : "text.secondary",
                      }}
                    >
                      {new Date(day).getDate()}
                    </Typography>
                  </Box>
                );
              })}
            </Box>

            {/* Bars, absolutely positioned over the cells so one can span several. */}
            {bars.map((bar) => {
              const session = byId.get(bar.sessionId);
              if (!session) return null;
              const colors = barColors(session.cwd, dark);
              return (
                <Tooltip key={`${bar.sessionId}-${bar.column}`} title={sessionTitle(session)}>
                  {/* The link is the positioned element and the Box inside it carries
                      the visuals: MUI's `component={Link}` can't be typed against the
                      router's typed params. */}
                  <Link
                    to="/sessions/$id"
                    params={{ id: bar.sessionId }}
                    data-testid="calendar-bar"
                    style={{
                      position: "absolute",
                      left: `calc(${(bar.column / 7) * 100}% + 3px)`,
                      width: `calc(${(bar.span / 7) * 100}% - 6px)`,
                      top: 26 + bar.lane * 20,
                      height: 17,
                      textDecoration: "none",
                    }}
                  >
                    <Box
                      sx={{
                        height: "100%",
                        bgcolor: colors.bg,
                        color: colors.text,
                        border: 1,
                        borderColor: colors.border,
                        // Open ends signal "this continues past the edge of the row",
                        // so a multi-week session doesn't read as several separate ones.
                        borderTopLeftRadius: bar.continuesLeft ? 0 : 4,
                        borderBottomLeftRadius: bar.continuesLeft ? 0 : 4,
                        borderTopRightRadius: bar.continuesRight ? 0 : 4,
                        borderBottomRightRadius: bar.continuesRight ? 0 : 4,
                        borderLeftWidth: bar.continuesLeft ? 0 : 1,
                        borderRightWidth: bar.continuesRight ? 0 : 1,
                        px: 0.5,
                        fontSize: 11,
                        lineHeight: "15px",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        "&:hover": { filter: "brightness(1.08)" },
                      }}
                    >
                      {bar.continuesLeft ? "… " : ""}
                      {projectName(session.cwd)}
                    </Box>
                  </Link>
                </Tooltip>
              );
            })}
          </Box>
        );
      })}
    </Paper>
  );
}

/** A 24-hour column for one day, sessions positioned and sized by clock time. */
function DayGrid({ dayStart, placed }: { dayStart: number; placed: Placed[] }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const placements = dayPlacements(
    dayStart,
    placed.map((p) => p.interval),
  );
  const onThisDay = placed.filter((p) => overlapsDay(p.interval, dayStart));

  if (onThisDay.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3 }} data-testid="calendar-day">
        <Typography color="text.secondary" variant="body2">
          No sessions on this day.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 1 }} data-testid="calendar-day">
      <Box sx={{ display: "flex", minHeight: 720 }}>
        {/* Hour ruler */}
        <Box sx={{ width: 44, flexShrink: 0, position: "relative" }}>
          {Array.from({ length: 24 }, (_, hour) => (
            <Typography
              key={hour}
              variant="caption"
              color="text.secondary"
              sx={{
                position: "absolute",
                top: `${(hour / 24) * 100}%`,
                right: 4,
                fontFamily: MONO,
                fontSize: 10,
                transform: "translateY(-50%)",
              }}
            >
              {String(hour).padStart(2, "0")}
            </Typography>
          ))}
        </Box>

        <Box sx={{ position: "relative", flex: 1, minWidth: 0 }}>
          {/* Hour rules, behind the bars. */}
          {Array.from({ length: 24 }, (_, hour) => (
            <Box
              key={hour}
              sx={{
                position: "absolute",
                top: `${(hour / 24) * 100}%`,
                left: 0,
                right: 0,
                borderTop: 1,
                borderColor: "divider",
                opacity: hour % 6 === 0 ? 1 : 0.4,
              }}
            />
          ))}

          {onThisDay.map(({ session, interval }) => {
            const place = placements.get(interval.sessionId);
            if (!place) return null;
            const colors = barColors(session.cwd, dark);
            const width = 100 / place.laneCount;
            return (
              <Tooltip key={session.sessionId} title={sessionTitle(session)}>
                <Link
                  to="/sessions/$id"
                  params={{ id: session.sessionId }}
                  data-testid="calendar-day-bar"
                  style={{
                    position: "absolute",
                    top: `${place.topPct}%`,
                    height: `${place.heightPct}%`,
                    left: `calc(${place.lane * width}% + 2px)`,
                    width: `calc(${width}% - 4px)`,
                    textDecoration: "none",
                  }}
                >
                  <Box
                    sx={{
                      height: "100%",
                      bgcolor: colors.bg,
                      color: colors.text,
                      border: 1,
                      borderColor: colors.border,
                      // Square off whichever end runs past midnight, matching the
                      // month grid's convention for "continues".
                      borderTopLeftRadius: place.startsEarlier ? 0 : 4,
                      borderTopRightRadius: place.startsEarlier ? 0 : 4,
                      borderBottomLeftRadius: place.endsLater ? 0 : 4,
                      borderBottomRightRadius: place.endsLater ? 0 : 4,
                      px: 0.5,
                      py: 0.25,
                      overflow: "hidden",
                      fontSize: 11,
                      lineHeight: 1.35,
                      "&:hover": { filter: "brightness(1.08)" },
                    }}
                  >
                    {place.heightPct >= LABEL_MIN_PCT && (
                      <>
                        <Box sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                          {projectName(session.cwd)}
                        </Box>
                        <Box sx={{ opacity: 0.8 }}>{formatDuration(session.durationMs)}</Box>
                      </>
                    )}
                  </Box>
                </Link>
              </Tooltip>
            );
          })}
        </Box>
      </Box>
    </Paper>
  );
}

export function SessionsCalendar({
  sessions,
  monthStart,
  daySelected,
  now,
  onMonth,
  onDay,
}: {
  sessions: SessionSummary[];
  monthStart: number;
  /** Local midnight of the day being examined, or undefined for the month view. */
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

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ mb: 1.5, flexWrap: "wrap", gap: 1 }}
      >
        {/* One navigation per click. Clearing the day separately used to be a second
            `navigate` in the same tick, and the router kept only one of the two — so
            the month label never moved. `onMonth` clears the day itself. */}
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
        <Button
          size="small"
          // `now` rather than Date.now(): the page fixed it once for this render, and
          // "Today" must agree with the day the grid is highlighting.
          onClick={() => onMonth(now)}
        >
          Today
        </Button>
        {daySelected !== undefined && (
          <>
            <Typography variant="body2" color="text.secondary">
              ·{" "}
              {new Date(daySelected).toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </Typography>
            <Button size="small" onClick={() => onDay(undefined)}>
              Back to month
            </Button>
          </>
        )}
      </Stack>

      {daySelected === undefined ? (
        <MonthGrid monthStart={monthStart} placed={placed} now={now} onPickDay={(d) => onDay(d)} />
      ) : (
        <DayGrid dayStart={daySelected} placed={placed} />
      )}

      {daySelected === undefined && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          {placed.length === 0
            ? "No sessions this month."
            : "Sessions are drawn across every day they ran. Click a day for its hour-by-hour view."}
        </Typography>
      )}
    </Box>
  );
}
