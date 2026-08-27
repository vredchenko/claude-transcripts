/**
 * `/search` — the full results page.
 *
 * Turn hits are grouped by session so the reader sees "3 matches in session X"
 * rather than a flat list. Session hits and turn hits are merged into session
 * groups. Honest counts: when `totals.sessions === 0` but turns exist, the count
 * of distinct session IDs from turns is used instead.
 */
import {
  Box,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Pagination,
  Paper,
  Select,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { Link, useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { getSearchQueryKey, type TurnHit, useSearch } from "../api/generated";
import { MarkedSnippet } from "../components/HighlightedText";
import { EmptyState, Loading } from "../components/states";
import { formatCount, formatTimestamp, projectName } from "../format";
import {
  type FilterKey,
  PAGE_SIZE,
  pageCount,
  pageNumber,
  type SearchRouteSearch,
  toSearchParams,
} from "../search-query";
import { MONO } from "../theme";

export type { SearchRouteSearch };

const MATCH_FIELD_LABELS: Record<string, string> = {
  cwd: "project",
  model: "model",
  hostname: "host",
  endReason: "end reason",
  tools: "tools",
};

const FILTERS = [
  { key: "cwd", label: "Project", format: projectName },
  { key: "model", label: "Model" },
  { key: "hostname", label: "Host" },
  { key: "source", label: "Source" },
] as const;

export function SearchResultsPage() {
  const routeSearch = useRouterSearch({ from: "/search" }) as SearchRouteSearch;
  const navigate = useNavigate();
  const theme = useTheme();

  const q = (routeSearch.q ?? "").trim();
  const page = pageNumber(routeSearch);
  const params = toSearchParams(routeSearch, PAGE_SIZE);

  const { data, isPending, isFetching } = useSearch(params, {
    query: {
      queryKey: getSearchQueryKey(params),
      placeholderData: (prev) => prev,
      enabled: q.length > 0,
    },
  });

  const setParam = (key: FilterKey | "q", value: string) =>
    navigate({
      to: "/search",
      search: (old: SearchRouteSearch) => ({ ...old, [key]: value || undefined, page: undefined }),
    });

  // Group turns by session for display.
  const turnsBySession = useMemo(() => {
    const map = new Map<string, TurnHit[]>();
    for (const t of data?.turns ?? []) {
      const list = map.get(t.sessionId) ?? [];
      list.push(t);
      map.set(t.sessionId, list);
    }
    return map;
  }, [data?.turns]);

  if (!q) {
    return <EmptyState>Type a query in the search box to explore the corpus.</EmptyState>;
  }
  if (isPending) return <Loading label="Searching…" />;
  if (data && !data.enabled) {
    return <EmptyState>Search is unavailable — Meilisearch isn't configured.</EmptyState>;
  }

  const hits = data?.hits ?? [];
  const turns = data?.turns ?? [];
  const totals = data?.totals ?? { sessions: 0, turns: 0 };
  const facets = data?.facets;
  const pages = pageCount(totals, PAGE_SIZE);
  const activeFilters = FILTERS.filter((f) => routeSearch[f.key]);

  // Honest session count: when the API reports 0 sessions but has turn hits,
  // count distinct session IDs from the turns.
  const sessionCount =
    totals.sessions > 0 ? totals.sessions : new Set(turns.map((t) => t.sessionId)).size;

  return (
    <Box>
      {/* Header */}
      <Stack
        direction="row"
        alignItems="baseline"
        justifyContent="space-between"
        sx={{ mb: 0.5, flexWrap: "wrap", gap: 1 }}
      >
        <Typography variant="h6">
          Results for <Chip size="small" label={q} sx={{ fontFamily: MONO }} />
        </Typography>
        <Link
          to="/"
          style={{ color: theme.palette.primary.main, textDecoration: "none", fontSize: 13 }}
        >
          ↩ narrow the list instead
        </Link>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        about {formatCount(sessionCount)} session{sessionCount === 1 ? "" : "s"} ·{" "}
        {formatCount(totals.turns)} turn{totals.turns === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </Typography>

      {/* Filters */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        {FILTERS.map((f) => {
          const options = facets?.[f.key] ?? [];
          if (options.length === 0) return null;
          const current = routeSearch[f.key] ?? "";
          return (
            <FormControl key={f.key} size="small" sx={{ minWidth: 160 }}>
              <InputLabel id={`filter-${f.key}`}>{f.label}</InputLabel>
              <Select
                labelId={`filter-${f.key}`}
                label={f.label}
                value={current}
                onChange={(e) => setParam(f.key, String(e.target.value))}
              >
                <MenuItem value="">
                  <em>Any</em>
                </MenuItem>
                {options.map((o) => (
                  <MenuItem key={o} value={o}>
                    {"format" in f && f.format ? f.format(o) : o}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          );
        })}
        {activeFilters.map((f) => (
          <Chip
            key={`clear-${f.key}`}
            size="small"
            label={`${f.label}: ${routeSearch[f.key]}`}
            onDelete={() => setParam(f.key, "")}
            sx={{ alignSelf: "center" }}
          />
        ))}
      </Stack>

      {hits.length === 0 && turns.length === 0 ? (
        <EmptyState title="No matches">No results for that query.</EmptyState>
      ) : (
        <Stack spacing={3}>
          {/* Session hits */}
          {hits.length > 0 && (
            <Box>
              <Typography variant="overline" color="text.secondary">
                Sessions
              </Typography>
              <Paper variant="outlined">
                {hits.map((h, i) => (
                  <Box key={h.sessionId}>
                    {i > 0 && <Divider />}
                    <Box sx={{ p: 1.5 }} data-testid="search-session-result">
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="baseline"
                        sx={{ flexWrap: "wrap", gap: 0.5 }}
                      >
                        <Link
                          to="/sessions/$id"
                          params={{ id: h.sessionId }}
                          search={{ q }}
                          style={{ color: theme.palette.primary.main, textDecoration: "none" }}
                        >
                          <Typography component="span" sx={{ fontWeight: 600 }}>
                            {projectName(h.cwd ?? "")}
                          </Typography>
                        </Link>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: MONO }}
                        >
                          {h.sessionId.slice(0, 8)}
                        </Typography>
                        {h.timestamp && (
                          <Typography variant="caption" color="text.secondary">
                            {formatTimestamp(h.timestamp)}
                          </Typography>
                        )}
                        {(h.matchedIn ?? []).map((field) => (
                          <Chip
                            key={field}
                            size="small"
                            variant="outlined"
                            color="warning"
                            label={`matched ${MATCH_FIELD_LABELS[field] ?? field}`}
                            sx={{ height: 18, fontSize: 10 }}
                          />
                        ))}
                      </Stack>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block", wordBreak: "break-word" }}
                      >
                        {[h.model, h.hostname, h.source].filter(Boolean).join(" · ")}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Paper>
            </Box>
          )}

          {/* Turn hits grouped by session */}
          {turnsBySession.size > 0 && (
            <Box>
              <Typography variant="overline" color="text.secondary">
                In conversations
              </Typography>
              <Paper variant="outlined">
                {[...turnsBySession.entries()].map(([sessionId, sessionTurns], gi) => (
                  <Box key={sessionId}>
                    {gi > 0 && <Divider sx={{ borderWidth: 2 }} />}
                    {/* Session group header */}
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="baseline"
                      sx={{
                        px: 1.5,
                        pt: 1.5,
                        pb: 0.5,
                        bgcolor: "action.hover",
                        flexWrap: "wrap",
                        gap: 0.5,
                      }}
                    >
                      <Link
                        to="/sessions/$id"
                        params={{ id: sessionId }}
                        search={{ q }}
                        style={{ color: theme.palette.primary.main, textDecoration: "none" }}
                      >
                        <Typography component="span" sx={{ fontWeight: 600 }}>
                          {projectName(sessionTurns[0]?.cwd ?? "")}
                        </Typography>
                      </Link>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: MONO }}
                      >
                        {sessionId.slice(0, 8)}
                      </Typography>
                      {sessionTurns[0]?.timestamp && (
                        <Typography variant="caption" color="text.secondary">
                          {formatTimestamp(sessionTurns[0].timestamp)}
                        </Typography>
                      )}
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${sessionTurns.length} hit${sessionTurns.length === 1 ? "" : "s"}`}
                        sx={{ height: 18, fontSize: 10 }}
                      />
                    </Stack>

                    {/* Turn hits under this session */}
                    {sessionTurns.map((t, ti) => (
                      <Box key={`${sessionId}-${ti}`}>
                        {ti > 0 && <Divider />}
                        <Box sx={{ p: 1.5 }} data-testid="search-turn-result">
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="baseline"
                            sx={{ minWidth: 0 }}
                          >
                            {t.timestamp && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontFamily: MONO, flexShrink: 0 }}
                              >
                                {formatTimestamp(t.timestamp).slice(11)}
                              </Typography>
                            )}
                            <Chip
                              size="small"
                              label={t.role}
                              sx={{ height: 18, fontSize: 10, flexShrink: 0 }}
                            />
                            <Typography
                              variant="body2"
                              sx={{ minWidth: 0, overflowWrap: "anywhere" }}
                            >
                              <MarkedSnippet snippet={t.snippet} />
                            </Typography>
                          </Stack>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                ))}
              </Paper>
            </Box>
          )}

          {pages > 1 && (
            <Pagination
              count={pages}
              page={page}
              onChange={(_, next) =>
                navigate({
                  to: "/search",
                  search: (old: SearchRouteSearch) => ({
                    ...old,
                    page: next === 1 ? undefined : next,
                  }),
                })
              }
              sx={{ alignSelf: "center" }}
            />
          )}
        </Stack>
      )}
    </Box>
  );
}
