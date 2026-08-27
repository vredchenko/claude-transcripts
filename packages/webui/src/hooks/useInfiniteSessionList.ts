import { useInfiniteQuery } from "@tanstack/react-query";
import { listSessions, type SessionsResponse } from "../api/generated";
import { groupByDay } from "../sessions-view";

const PAGE = 50;

/**
 * Wraps `useInfiniteQuery` over `GET /api/sessions`, accumulating pages as the
 * reader scrolls. Exposes sessions, day groups, and paging controls.
 */
export function useInfiniteSessionList(params?: { from?: string; to?: string }) {
  const query = useInfiniteQuery<SessionsResponse>({
    queryKey: ["/api/sessions", "infinite", params],
    queryFn: ({ pageParam }) => listSessions({ limit: PAGE, skip: pageParam as number, ...params }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.sessions.length, 0);
      return loaded < lastPage.totalCount ? loaded : undefined;
    },
  });

  const sessions = query.data?.pages.flatMap((p) => p.sessions) ?? [];
  const totalCount = query.data?.pages[0]?.totalCount ?? 0;

  const dayGroups = groupByDay(sessions, (s) => Date.parse(s.startTimestamp ?? s.timestamp) || 0);

  return {
    sessions,
    dayGroups,
    totalCount,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  };
}
