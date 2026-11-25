/**
 * Sessions as intervals on a calendar — now a vertical stack of 24h lanes, one
 * per day. Each day is a row: left cell (day label + session count + active time),
 * right cell (24h lane with session bars positioned by clock time).
 *
 * Opens on all of history, newest day first, loaded as you scroll; **Month** narrows
 * it to one month with ‹ › / Today navigation. Click a bar to open the session detail.
 *
 * Each lane is shaded by daylight — night, civil twilight, day — at the configured
 * location or the browser's time zone's reference point (see `daylight.ts`), so a
 * session's bar shows whether it ran in the light or the dark, and the days visibly
 * lengthen and shorten as you scroll through the year.
 */
import {
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useUserSettings } from "../../api/blueprint";
import type { SessionSummary } from "../../api/generated";
import {
  browserTimeZone,
  type DaylightPlace,
  daylightPlace,
  type LightStop,
  lightStops,
} from "../../daylight";
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
import { BELOW_HEADER_STICKY } from "../Header";

/** Even-hour labels for the axis header. */
const HOUR_LABELS = Array.from({ length: 12 }, (_, i) => i * 2);

/** Stable colour per project via golden-angle-stepped hue hash. */
function projectHue(cwd: string | undefined): number {
  let hash = 0;
  for (const char of cwd ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash * 137.508) % 360;
}

/** Lane tint at full night and full day; twilight is mixed between them. */
const NIGHT_RGBA = [10, 14, 40, 0.45] as const;
const DAY_RGBA = [255, 214, 140, 0.07] as const;

function lightColour(light: number): string {
  const mix = NIGHT_RGBA.map((n, i) => n + ((DAY_RGBA[i] ?? n) - n) * light);
  const [r, g, b, a] = mix as [number, number, number, number];
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`;
}

/** A day's light as a left-to-right CSS gradient behind its lane. */
function daylightGradient(stops: LightStop[]): string {
  const parts = stops.map((s) => `${lightColour(s.light)} ${s.pct.toFixed(2)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** How many projects the legend names before summing the rest as "+N more". */
const LEGEND_SHOWN = 8;

/** Bar colour for a project, at a given opacity. */
function projectColour(cwd: string | undefined, opacity: number): string {
  return `hsla(${projectHue(cwd)}, 45%, 50%, ${opacity})`;
}

/** The month's projects, busiest first: what each bar colour means. */
function ProjectLegend({
  sessions,
  place,
}: {
  sessions: SessionSummary[];
  place: DaylightPlace | undefined;
}) {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.cwd ?? "", (counts.get(s.cwd ?? "") ?? 0) + 1);
  const projects = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (projects.length === 0) return null;
  const rest = projects.length - LEGEND_SHOWN;
  return (
    <Stack
      direction="row"
      alignItems="center"
      sx={{ flexWrap: "wrap", columnGap: 1.5, rowGap: 0.5, mb: 1 }}
      data-testid="calendar-legend"
    >
      {projects.slice(0, LEGEND_SHOWN).map(([cwd, n]) => (
        <Tooltip
          key={cwd}
          title={`${cwd || "unknown directory"} · ${n} session${n === 1 ? "" : "s"}`}
        >
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Box
              sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: projectColour(cwd, 0.75) }}
            />
            <Typography variant="caption" color="text.secondary">
              {projectName(cwd)}
            </Typography>
          </Stack>
        </Tooltip>
      ))}
      {rest > 0 && (
        <Typography variant="caption" color="text.secondary">
          +{rest} more
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled" sx={{ ml: "auto" }}>
        brighter bar = more of its runtime active
      </Typography>
      <DaylightKey place={place} />
    </Stack>
  );
}

/** What the lane shading means, and where its sun is. */
function DaylightKey({ place }: { place: DaylightPlace | undefined }) {
  const where = !place
    ? "No daylight shading: set userSettings.location in config/config.json, or use a browser whose time zone names a place."
    : place.source === "config"
      ? `Daylight at ${place.location.latitude.toFixed(2)}, ${place.location.longitude.toFixed(2)} (userSettings.location).`
      : `Daylight at the reference point of your time zone, ${place.source.timeZone}. Set userSettings.location in config/config.json to be exact.`;
  return (
    <Tooltip title={where}>
      <Stack direction="row" spacing={0.5} alignItems="center" data-testid="calendar-daylight-key">
        <Box
          sx={{
            width: 28,
            height: 10,
            borderRadius: 0.5,
            border: 1,
            borderColor: "divider",
            background: place
              ? `linear-gradient(to right, ${lightColour(0)}, ${lightColour(1)}, ${lightColour(0)})`
              : undefined,
          }}
        />
        <Typography variant="caption" color="text.disabled">
          {place ? "night · day" : "no daylight"}
        </Typography>
      </Stack>
    </Tooltip>
  );
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
function DayLane({
  dayStart,
  placed,
  now,
  place,
}: {
  dayStart: number;
  placed: Placed[];
  now: number;
  place: DaylightPlace | undefined;
}) {
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
        {/* Count and active time on lines of their own: run together they wrapped
            mid-figure ("56m" / "14s") in a cell this narrow. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {sessionsOnDay.length} session{sessionsOnDay.length === 1 ? "" : "s"}
        </Typography>
        {activeMs > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            {formatDuration(activeMs)} active
          </Typography>
        )}
      </Box>

      {/* 24h lane, shaded by that day's daylight */}
      <Box
        sx={{
          flex: 1,
          position: "relative",
          minHeight: 36,
          minWidth: 0,
          background: place ? daylightGradient(lightStops(dayStart, place.location)) : undefined,
        }}
      >
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
                    bgcolor: projectColour(session.cwd, opacity),
                    borderRadius: 0.5,
                    px: 0.5,
                    fontSize: 10,
                    lineHeight: "18px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "text.primary",
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
  /** The month shown, or undefined for all of history. */
  monthStart: number | undefined;
  daySelected?: number;
  now: number;
  onMonth: (monthStart: number | undefined) => void;
  onDay: (dayStart: number | undefined) => void;
}) {
  const { location } = useUserSettings();
  const place = useMemo(() => daylightPlace(location, browserTimeZone()), [location]);

  const placed: Placed[] = [];
  let undated = 0;
  for (const session of sessions) {
    const interval = toInterval(session, now);
    if (interval) placed.push({ session, interval });
    else undated += 1;
  }

  const monthLabel =
    monthStart === undefined
      ? undefined
      : new Date(monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  // Group sessions by day for the vertical stack.
  const dayGroups = groupByDay(placed, (p) => p.interval.start);

  return (
    <Box data-testid="calendar-lanes">
      {/* Range: all of history, or one month with its navigation */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ mb: 1.5, flexWrap: "wrap", gap: 1 }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={monthStart === undefined ? "all" : "month"}
          onChange={(_e, value: "all" | "month" | null) => {
            if (value === "all") onMonth(undefined);
            // Into a month: the one the newest loaded day is in, else this one.
            else if (value === "month") onMonth(dayGroups[0]?.dayStart ?? now);
          }}
          aria-label="calendar range"
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="month">Month</ToggleButton>
        </ToggleButtonGroup>
        {monthStart !== undefined && (
          <>
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
          </>
        )}
      </Stack>

      {/* Bars are coloured by project and brightened by their active share; the old
          "active / idle" swatches showed the primary colour, which no bar uses. */}
      <ProjectLegend sessions={sessions} place={place} />

      {/* Hour axis header — sticky, like the list's column header, so a long scroll
          through history keeps its clock */}
      <Box
        sx={{
          display: "flex",
          borderBottom: 2,
          borderColor: "divider",
          bgcolor: "background.paper",
          ...BELOW_HEADER_STICKY,
        }}
      >
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
            {monthStart === undefined ? "No sessions recorded yet." : "No sessions this month."}
          </Typography>
        ) : (
          dayGroups.map((group) => (
            <DayLane
              key={group.key}
              dayStart={group.dayStart}
              placed={group.items}
              now={now}
              place={place}
            />
          ))
        )}
      </Paper>
      {undated > 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="calendar-undated"
          sx={{ display: "block", mt: 1 }}
        >
          {undated === 1
            ? "1 session has no start time and isn't shown; it is in the list view."
            : `${undated} sessions have no start time and aren't shown; they are in the list view.`}
        </Typography>
      )}
    </Box>
  );
}
