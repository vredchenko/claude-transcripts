/**
 * Root route: the session list, in whichever projection you asked for.
 *
 * Two projections: a day-grouped list (the default, replacing the old table and
 * timeline) and a calendar. The list uses infinite scroll, newest first — its one
 * order, since the day grouping *is* the ordering; the calendar fetches the month's
 * range. All URL state is linkable and back-button-navigable.
 */
import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { getListSessionsQueryKey, useListSessions } from "../api/generated";
import { SessionsCalendar } from "../components/sessions/SessionsCalendar";
import {
  type RowSelection,
  SessionsList,
  SessionsListHeader,
} from "../components/sessions/SessionsList";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatCount, formatDuration } from "../format";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useInfiniteSessionList } from "../hooks/useInfiniteSessionList";
import { useIntersectionObserver } from "../hooks/useIntersectionObserver";
import { dayKey, dayRollup, monthKey, monthWeeks, parseDay, parseMonth } from "../sessions-view";

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

/**
 * The filters a chip can show and delete, in the order they appear. `cwd`, `model`,
 * `hostname` and `source` are exact-match query params on `GET /api/sessions`;
 * `from`/`to` narrow it to a range.
 */
const FILTER_KEYS = ["cwd", "model", "hostname", "source", "from", "to"] as const;

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
  useDocumentTitle(
    view === "calendar"
      ? `Calendar · ${new Date(monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`
      : "Sessions",
  );

  // ── Filters ─────────────────────────────────────────────────────────────────
  //
  // The four attribute filters go to the gateway, which matches them exactly, rather
  // than being applied to whatever pages happen to be loaded: the list is
  // infinite-scrolled, so a client-side filter would narrow the first page and let
  // the next one arrive unfiltered underneath it. `from`/`to` ride along on the list
  // but not the calendar, whose range *is* the month it is drawing.
  const filters = useMemo(
    () => ({
      cwd: routeSearch.cwd,
      model: routeSearch.model,
      hostname: routeSearch.hostname,
      source: routeSearch.source,
    }),
    [routeSearch.cwd, routeSearch.model, routeSearch.hostname, routeSearch.source],
  );

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

  const calendarParams = useMemo(
    () => ({
      limit: CALENDAR_LIMIT,
      skip: 0,
      from: calendarRange.from,
      to: calendarRange.to,
      ...filters,
    }),
    [calendarRange, filters],
  );

  const calendarQuery = useListSessions(calendarParams, {
    query: {
      queryKey: getListSessionsQueryKey(calendarParams),
      placeholderData: (prev) => prev,
      enabled: view === "calendar",
    },
  });

  // ── List data (infinite scroll) ─────────────────────────────────────────────
  const listData = useInfiniteSessionList(
    view === "list" ? { from: routeSearch.from, to: routeSearch.to, ...filters } : undefined,
  );

  const sentinelRef = useIntersectionObserver(
    () => listData.fetchNextPage(),
    view === "list" && listData.hasNextPage === true && !listData.isFetchingNextPage,
  );

  // ── Row selection ───────────────────────────────────────────────────────────
  //
  // Held here rather than in the URL: it's a scratch set for "what do these add up
  // to", not something to link to. Ids, not rows, so it survives the next page
  // arriving; totals are taken over the loaded rows it names, so a selected session
  // that a filter has since hidden drops out of the sum and the count alike.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const selection: RowSelection = useMemo(
    () => ({
      selected: selectedIds,
      onToggle: (ids, on) =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) on ? next.add(id) : next.delete(id);
          return next;
        }),
    }),
    [selectedIds],
  );
  const selectedSessions = listData.sessions.filter((s) => selectedIds.has(s.sessionId));
  const selectedRollup = dayRollup(selectedSessions);

  /** Replace part of the query string, leaving the rest alone. */
  const setSearch = useCallback(
    (next: Partial<SessionsRouteSearch>) =>
      navigate({ to: "/", search: (old: SessionsRouteSearch) => ({ ...old, ...next }) }),
    [navigate],
  );

  // ── Active filter chips ─────────────────────────────────────────────────────
  const activeFilters = FILTER_KEYS.filter((k) => routeSearch[k]);

  // ── Pending / error states ──────────────────────────────────────────────────
  if (view === "list" && listData.isPending) return <Loading label="Loading sessions…" />;
  if (view === "list" && listData.isError) return <ErrorState error={listData.error!} />;
  if (view === "calendar" && calendarQuery.isPending) return <Loading label="Loading sessions…" />;
  if (view === "calendar" && calendarQuery.isError)
    return <ErrorState error={calendarQuery.error!} />;

  // Counts for whichever projection is showing. The list query is disabled in
  // calendar view (and vice versa), so reading the wrong one reports zero — which is
  // what "N of M shown" did on a filtered calendar.
  const shownCount =
    view === "calendar" ? (calendarQuery.data?.sessions.length ?? 0) : listData.sessions.length;
  const totalCount =
    view === "calendar" ? (calendarQuery.data?.totalCount ?? 0) : listData.totalCount;

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
                ? `${formatCount(shownCount)} of ${formatCount(totalCount)} shown`
                : view === "calendar"
                  ? // The calendar fetches one month, so its total is the month's, not
                    // the corpus's: say so, or it reads as a different "sessions" count.
                    `${formatCount(totalCount)} this month`
                  : `${formatCount(totalCount)} sessions`
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
        <EmptyState>
          {activeFilters.length > 0
            ? "No sessions match these filters."
            : "No sessions recorded yet."}
        </EmptyState>
      ) : (
        <>
          {selectedSessions.length > 0 && (
            <Paper
              variant="outlined"
              data-testid="selection-bar"
              sx={{
                position: "sticky",
                top: 0,
                zIndex: 2,
                mb: 1,
                px: 1.5,
                py: 0.75,
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 1.5,
                borderColor: "primary.main",
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {formatCount(selectedSessions.length)} selected
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {formatDuration(selectedRollup.activeMs)} active ·{" "}
                {formatCount(selectedRollup.tokens)} tokens ·{" "}
                {formatCount(selectedSessions.reduce((n, s) => n + s.promptCount, 0))} turns
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Button size="small" onClick={() => setSelectedIds(new Set())}>
                Clear selection
              </Button>
            </Paper>
          )}
          <SessionsListHeader
            sessionIds={listData.sessions.map((s) => s.sessionId)}
            selection={selection}
          />
          <SessionsList dayGroups={listData.dayGroups} selection={selection} />

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
