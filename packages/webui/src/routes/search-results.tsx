/**
 * `/search` — the full results page.
 *
 * The header dropdown ([SearchBox](../components/SearchBox.tsx)) answers "jump to that
 * session": a handful of hits, no paging, no filters. This page answers the other
 * question — "what is in this corpus?" — which needs the things a dropdown can't have:
 * every match rather than the top few, filters over the whole corpus, and paging.
 *
 * The query lives in the URL (`/search?q=…&cwd=…`), so a result set is linkable and the
 * back button works. That also makes the header box's "see all results" a plain link
 * rather than shared state between two components.
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
import { getSearchQueryKey, useSearch } from "../api/generated";
import { EmptyState, Loading } from "../components/states";
import { projectName } from "../format";
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

/** Labels (and display formatting) for the filter controls, in render order. */
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
      // Keep the previous page visible while the next loads, so paging doesn't flash
      // an empty results area.
      placeholderData: (prev) => prev,
      enabled: q.length > 0,
    },
  });

  /** Replace one query-string value, resetting to page 1 — a new filter means new results. */
  const setParam = (key: FilterKey | "q", value: string) =>
    navigate({
      to: "/search",
      search: (old: SearchRouteSearch) => ({
        ...old,
        [key]: value || undefined,
        page: undefined,
      }),
    });

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

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        Results for{" "}
        <Box component="span" sx={{ fontFamily: MONO }}>
          {q}
        </Box>
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {/* "about" because Meilisearch's count is an estimate on a large corpus. */}
        about {totals.sessions} session{totals.sessions === 1 ? "" : "s"} · {totals.turns} turn
        {totals.turns === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </Typography>

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
        <EmptyState>No matches for that query.</EmptyState>
      ) : (
        <Stack spacing={3}>
          {hits.length > 0 && (
            <Box>
              <Typography variant="overline" color="text.secondary">
                Sessions
              </Typography>
              <Paper variant="outlined">
                {hits.map((h, i) => (
                  <Box key={h.sessionId}>
                    {i > 0 && <Divider />}
                    <Box sx={{ p: 1.5 }}>
                      <Link
                        to="/sessions/$id"
                        params={{ id: h.sessionId }}
                        style={{ color: theme.palette.primary.main, textDecoration: "none" }}
                      >
                        {projectName(h.cwd ?? "")}
                      </Link>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block", fontFamily: MONO }}
                      >
                        {h.sessionId}
                        {h.model ? ` · ${h.model}` : ""}
                        {h.hostname ? ` · ${h.hostname}` : ""}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Paper>
            </Box>
          )}

          {turns.length > 0 && (
            <Box>
              <Typography variant="overline" color="text.secondary">
                In conversations
              </Typography>
              <Paper variant="outlined">
                {turns.map((t, i) => (
                  // Turn hits carry no stable client id; position in the page is fine.
                  <Box key={`${t.sessionId}-${i}`}>
                    {i > 0 && <Divider />}
                    <Box sx={{ p: 1.5 }}>
                      <Stack direction="row" spacing={1} alignItems="baseline">
                        <Chip size="small" label={t.role} sx={{ height: 18, fontSize: 10 }} />
                        <Typography variant="body2" sx={{ color: theme.palette.text.primary }}>
                          {t.snippet}
                        </Typography>
                      </Stack>
                      <Link
                        to="/sessions/$id"
                        params={{ id: t.sessionId }}
                        style={{ color: theme.palette.primary.main, textDecoration: "none" }}
                      >
                        <Typography component="span" variant="caption" sx={{ fontFamily: MONO }}>
                          {projectName(t.cwd ?? "")} · {t.sessionId}
                        </Typography>
                      </Link>
                    </Box>
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
