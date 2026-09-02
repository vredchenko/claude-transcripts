/**
 * Root route: the session list, in whichever projection you asked for.
 *
 * Two projections: a day-grouped list (the default, replacing the old table and
 * timeline) and a calendar. The list uses infinite scroll, newest first — its one
 * order, since the day grouping *is* the ordering; the calendar fetches the month's
 * range. All URL state is linkable and back-button-navigable.
 */
import { Box, Chip, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { getListSessionsQueryKey, useListSessions } from "../api/generated";
import { SessionsCalendar } from "../components/sessions/SessionsCalendar";
import { SessionsList, SessionsListHeader } from "../components/sessions/SessionsList";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatCount } from "../format";
import { useInfiniteSessionList } from "../hooks/useInfiniteSessionList";
import { useIntersectionObserver } from "../hooks/useIntersectionObserver";
import { dayKey, monthKey, monthWeeks, parseDay, parseMonth } from "../sessions-view";

/**
 * How many sessions the calendar will draw for one month. Far above any plausible
 * month and bounded so a pathological range can't ask the gateway for everything.
 */
const CALENDAR_LIMIT = 500;

export type SessionsView = "list" | "calendar";

/** Query-string state this route owns. */
export interface SessionsRouteSearch {
  view?: SessionsView;
  /** Calendar only: `YYYY-MM`, and `YYYY-MM-DD` once a day is opened. */
  month?: string;
  day?: string;
  /** Filter params. */
  cwd?: string;
  model?: string;
  hostname?: string;
  source?: string;
  from?: string;
  to?: string;
}

const VIEWS: { value: SessionsView; label: string }[] = [
  { value: "list", label: "List" },
  { value: "calendar", label: "Calendar" },
];

export function SessionsListPage() {
  const routeSearch = useRouterSearch({ from: "/" }) as SessionsRouteSearch;
  const navigate = useNavigate();

  const view = routeSearch.view ?? "list";

  /**
   * Fixed for the lifetime of the render pass. A running session's extent is measured
   * against "now", and re-reading the clock inside the layout maths would give a
   * different answer to each component in the same frame.
   */
  const now = useMemo(() => Date.now(), []);

  const monthStart = parseMonth(routeSearch.month, now);
  const daySelected = parseDay(routeSearch.day);

  // ── Calendar data ───────────────────────────────────────────────────────────
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

  const calendarQuery = useListSessions(
    { limit: CALENDAR_LIMIT, skip: 0, from: calendarRange.from, to: calendarRange.to },
    {
      query: {
        queryKey: getListSessionsQueryKey({
          limit: CALENDAR_LIMIT,
          skip: 0,
          from: calendarRange.from,
          to: calendarRange.to,
        }),
        placeholderData: (prev) => prev,
        enabled: view === "calendar",
      },
    },
  );

  // ── List data (infinite scroll) ─────────────────────────────────────────────
  const listData = useInfiniteSessionList(
    view === "list" ? { from: routeSearch.from, to: routeSearch.to } : undefined,
  );

  const sentinelRef = useIntersectionObserver(
    () => listData.fetchNextPage(),
    view === "list" && listData.hasNextPage === true && !listData.isFetchingNextPage,
  );

  /** Replace part of the query string, leaving the rest alone. */
  const setSearch = useCallback(
    (next: Partial<SessionsRouteSearch>) =>
      navigate({ to: "/", search: (old: SessionsRouteSearch) => ({ ...old, ...next }) }),
    [navigate],
  );

  // ── Active filter chips ─────────────────────────────────────────────────────
  const filterKeys = ["cwd", "model", "hostname", "source", "from", "to"] as const;
  const activeFilters = filterKeys.filter((k) => routeSearch[k]);

  // ── Pending / error states ──────────────────────────────────────────────────
  if (view === "list" && listData.isPending) return <Loading label="Loading sessions…" />;
  if (view === "list" && listData.isError) return <ErrorState error={listData.error!} />;
  if (view === "calendar" && calendarQuery.isPending) return <Loading label="Loading sessions…" />;
  if (view === "calendar" && calendarQuery.isError)
    return <ErrorState error={calendarQuery.error!} />;

  const listTotal = listData.totalCount;
  const listShown = listData.sessions.length;

  return (
    <Box>
      {/* Toolbar */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 2, flexWrap: "wrap", gap: 1 }}
      >
        <Stack direction="row" spacing={1} alignItems="baseline">
          <Typography variant="h5">Sessions</Typography>
          <Chip
            size="small"
            label={
              activeFilters.length > 0
                ? `${formatCount(listShown)} of ${formatCount(listTotal)} shown`
                : `${formatCount(view === "calendar" ? (calendarQuery.data?.totalCount ?? 0) : listTotal)} sessions`
            }
            variant="outlined"
          />
        </Stack>

        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 0.5 }}>
          {/* Active filter chips */}
          {activeFilters.map((key) => (
            <Chip
              key={key}
              size="small"
              label={`${key}: ${routeSearch[key]}`}
              onDelete={() => setSearch({ [key]: undefined })}
            />
          ))}

          <ToggleButtonGroup
            size="small"
            exclusive
            value={view}
            onChange={(_e, value: SessionsView | null) =>
              value &&
              setSearch({
                view: value === "list" ? undefined : value,
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

      {/* Calendar renders even with nothing — its month nav must remain reachable. */}
      {view === "calendar" ? (
        <SessionsCalendar
          sessions={calendarQuery.data?.sessions ?? []}
          monthStart={monthStart}
          daySelected={daySelected}
          now={now}
          onMonth={(next) => setSearch({ month: monthKey(next), day: undefined })}
          onDay={(next) => setSearch({ day: next === undefined ? undefined : dayKey(next) })}
        />
      ) : listData.sessions.length === 0 ? (
        <EmptyState>No sessions recorded yet.</EmptyState>
      ) : (
        <>
          <SessionsListHeader />
          <SessionsList dayGroups={listData.dayGroups} />

          {/* Sentinel for infinite scroll */}
          <div ref={sentinelRef} style={{ height: 1 }} />

          {listData.isFetchingNextPage && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", textAlign: "center", py: 2 }}
            >
              Loading more sessions…
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
