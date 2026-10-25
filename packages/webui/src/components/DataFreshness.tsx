import { Box, CircularProgress, IconButton, Tooltip, Typography } from "@mui/material";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatAgo, formatTimestamp } from "../format";

/** How often the "loaded … ago" label re-reads the clock. */
const TICK_MS = 15_000;

/**
 * The newest successful fetch among the queries on screen. Inactive queries (a page you
 * navigated away from) don't count: their age says nothing about what you're looking at.
 */
function useLastLoaded(): number | undefined {
  const client = useQueryClient();
  const read = () => {
    let newest = 0;
    for (const q of client.getQueryCache().getAll()) {
      if (q.getObserversCount() > 0 && q.state.dataUpdatedAt > newest) {
        newest = q.state.dataUpdatedAt;
      }
    }
    return newest || undefined;
  };
  const [lastLoaded, setLastLoaded] = useState(read);
  useEffect(() => client.getQueryCache().subscribe(() => setLastLoaded(read())));
  return lastLoaded;
}

/**
 * "loaded 2m ago" and a refresh button, for the header.
 *
 * The list, a session and search results are fetched once and then held (a 30s stale
 * time, no refetch on focus), so a page left open quietly goes out of date. This says
 * how old it is and refetches everything on screen in one click, without a full reload.
 */
export function DataFreshness() {
  const client = useQueryClient();
  const fetching = useIsFetching() > 0;
  const lastLoaded = useLastLoaded();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
      {lastLoaded !== undefined && (
        <Tooltip title={`Data loaded ${formatTimestamp(new Date(lastLoaded).toISOString())}`}>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: { xs: "none", md: "block" } }}
          >
            loaded {formatAgo(lastLoaded, Math.max(now, lastLoaded))}
          </Typography>
        </Tooltip>
      )}
      <Tooltip title="Refresh">
        <span>
          <IconButton
            size="small"
            color="inherit"
            aria-label="Refresh data"
            disabled={fetching}
            onClick={() => client.invalidateQueries({ refetchType: "active" })}
            sx={{ width: 30, height: 30 }}
          >
            {fetching ? <CircularProgress size={14} color="inherit" /> : "⟳"}
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
