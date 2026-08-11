/**
 * Root route: the session list, in whichever projection you asked for.
 *
 * The same corpus answers different questions depending on how it's drawn — a table
 * compares, a timeline shows recent work in order, a calendar shows *when* and for how
 * long. So the projection is a view of one list rather than three separate pages, and
 * it lives in the URL (`/?view=calendar&month=2026-03`) like the search route's state:
 * a particular view is linkable, and the back button steps through them.
 *
 * Table and timeline page through the newest sessions; the calendar instead asks for
 * the month it is showing (`from`/`to`), because a month is a window, not a page.
 */
import { Box, Button, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { getListSessionsQueryKey, useListSessions } from "../api/generated";
import { SessionsCalendar } from "../components/sessions/SessionsCalendar";
import { SessionsTable } from "../components/sessions/SessionsTable";
import { SessionsTimeline, type TimelineDensity } from "../components/sessions/SessionsTimeline";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatCount } from "../format";
import { dayKey, monthKey, monthWeeks, parseDay, parseMonth } from "../sessions-view";

const PAGE = 50;

/**
 * How many sessions the calendar will draw for one month. Far above any plausible
 * month (the busiest in the author's corpus is a few dozen) and bounded so a
 * pathological range can't ask the gateway for everything at once.
 */
const CALENDAR_LIMIT = 500;

export type SessionsView = "table" | "timeline" | "calendar";

/** Query-string state this route owns. */
export interface SessionsRouteSearch {
  view?: SessionsView;
  /** Timeline only. */
  density?: TimelineDensity;
  /** Calendar only: `YYYY-MM`, and `YYYY-MM-DD` once a day is opened. */
  month?: string;
  day?: string;
}

const VIEWS: { value: SessionsView; label: string }[] = [
  { value: "table", label: "Table" },
  { value: "timeline", label: "Timeline" },
  { value: "calendar", label: "Calendar" },
];

const DENSITIES: { value: TimelineDensity; label: string; hint: string }[] = [
  { value: "cards", label: "Cards", hint: "Full detail per session" },
  { value: "compact", label: "Compact", hint: "One line per session" },
  { value: "proportional", label: "To scale", hint: "Spaced by real elapsed time" },
];

export function SessionsListPage() {
  const routeSearch = useRouterSearch({ from: "/" }) as SessionsRouteSearch;
  const navigate = useNavigate();
  const [skip, setSkip] = useState(0);

  const view = routeSearch.view ?? "table";
  const density = routeSearch.density ?? "cards";

  /**
   * Fixed for the lifetime of the render pass. A running session's extent is measured
   * against "now", and re-reading the clock inside the layout maths would give a
   * different answer to each component in the same frame.
   */
  const now = useMemo(() => Date.now(), []);

  const monthStart = parseMonth(routeSearch.month, now);
  const daySelected = parseDay(routeSearch.day);

  /**
   * The calendar asks for everything its grid can show — including the leading and
   * trailing days borrowed from the neighbouring months, which is why the range comes
   * from the grid rather than from the month.
   */
  const calendarRange = useMemo(() => {
    const weeks = monthWeeks(monthStart);
    const first = weeks[0]?.[0] ?? monthStart;
    const lastDay = weeks[5]?.[6] ?? monthStart;
    const end = new Date(
      new Date(lastDay).getFullYear(),
      new Date(lastDay).getMonth(),
      new Date(lastDay).getDate() + 1,
    ).getTime();
    return { from: new Date(first).toISOString(), to: new Date(end).toISOString() };
  }, [monthStart]);

  const params =
    view === "calendar"
      ? { limit: CALENDAR_LIMIT, skip: 0, from: calendarRange.from, to: calendarRange.to }
      : { limit: PAGE, skip };

  const { data, isPending, isError, error, isPlaceholderData } = useListSessions(params, {
    // The generated hooks keep react-query options under `query`, leaving the sibling
    // `request` slot for per-call fetch options. `queryKey` is typed as required even
    // though the generated hook defaults it, so it's passed through the generated
    // helper rather than spelled out — an invented key here would silently split the
    // cache from every other caller of this route.
    query: {
      queryKey: getListSessionsQueryKey(params),
      placeholderData: (prev) => prev,
    },
  });

  /** Replace part of the query string, leaving the rest alone. */
  const setSearch = (next: Partial<SessionsRouteSearch>) =>
    navigate({ to: "/", search: (old: SessionsRouteSearch) => ({ ...old, ...next }) });

  if (isPending) return <Loading label="Loading sessions…" />;
  if (isError) return <ErrorState error={error} />;

  const sessions = data?.sessions ?? [];
  const total = data?.totalCount ?? sessions.length;
  const hasMore = skip + PAGE < total;
  const paged = view !== "calendar";

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 2, flexWrap: "wrap", gap: 1 }}
      >
        <Stack direction="row" spacing={2} alignItems="baseline">
          <Typography variant="h5">Sessions</Typography>
          <Typography color="text.secondary" variant="body2">
            {formatCount(total)} {view === "calendar" ? "this month" : "total"}
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
          {view === "timeline" && (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={density}
              onChange={(_e, value: TimelineDensity | null) =>
                value && setSearch({ density: value })
              }
              aria-label="timeline density"
            >
              {DENSITIES.map((d) => (
                <ToggleButton key={d.value} value={d.value} title={d.hint}>
                  {d.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          <ToggleButtonGroup
            size="small"
            exclusive
            value={view}
            onChange={(_e, value: SessionsView | null) =>
              value &&
              setSearch({
                view: value === "table" ? undefined : value,
                // Leaving a stale `day` behind would open the calendar on a day the
                // reader last looked at weeks ago.
                day: undefined,
                month: value === "calendar" ? (routeSearch.month ?? monthKey(now)) : undefined,
              })
            }
            aria-label="session view"
          >
            {VIEWS.map((v) => (
              <ToggleButton key={v.value} value={v.value}>
                {v.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Stack>
      </Stack>

      {/* The calendar renders even with nothing to show. Replacing it with an empty
          state takes its month navigation away with it, so paging into a quiet month
          strands you there with no way back — an empty calendar is still a calendar,
          and it says so itself. */}
      {view === "calendar" ? (
        <SessionsCalendar
          sessions={sessions}
          monthStart={monthStart}
          daySelected={daySelected}
          now={now}
          onMonth={(next) => setSearch({ month: monthKey(next), day: undefined })}
          onDay={(next) => setSearch({ day: next === undefined ? undefined : dayKey(next) })}
        />
      ) : sessions.length === 0 ? (
        <EmptyState>No sessions recorded yet.</EmptyState>
      ) : view === "table" ? (
        <SessionsTable sessions={sessions} dimmed={isPlaceholderData} />
      ) : (
        <Box sx={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
          <SessionsTimeline sessions={sessions} density={density} now={now} />
        </Box>
      )}

      {paged && sessions.length > 0 && (
        <Stack
          direction="row"
          spacing={2}
          justifyContent="center"
          alignItems="center"
          sx={{ mt: 2 }}
        >
          <Button
            disabled={skip === 0 || isPlaceholderData}
            onClick={() => setSkip((n) => Math.max(0, n - PAGE))}
          >
            Previous
          </Button>
          <Typography variant="body2" color="text.secondary">
            {formatCount(skip + 1)}–{formatCount(Math.min(skip + PAGE, total))}
          </Typography>
          <Button disabled={!hasMore || isPlaceholderData} onClick={() => setSkip((n) => n + PAGE)}>
            Next
          </Button>
        </Stack>
      )}
    </Box>
  );
}
