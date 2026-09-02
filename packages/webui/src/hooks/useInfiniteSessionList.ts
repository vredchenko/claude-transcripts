import { useInfiniteQuery } from "@tanstack/react-query";
import { listSessions, type SessionsResponse } from "../api/generated";
import { useUserSettings } from "../api/model";
import { groupByDay } from "../sessions-view";

/**
 * Wraps `useInfiniteQuery` over `GET /api/sessions`, accumulating pages as the
 * reader scrolls. Exposes sessions, day groups, and paging controls.
 *
 * The page size is deployment config (`userSettings.sessionListPageSize`), not a
 * constant: it is the one number that trades round trips against time-to-first-row,
 * and the right answer depends on the corpus and the machine serving it.
 */
export function useInfiniteSessionList(params?: { from?: string; to?: string }) {
  const { sessionListPageSize: pageSize } = useUserSettings();

  const query = useInfiniteQuery<SessionsResponse>({
    // The page size is part of the identity of these pages: changing it must start a
    // fresh list rather than append differently-sized pages onto the cached ones.
    queryKey: ["/api/sessions", "infinite", pageSize, params],
    queryFn: ({ pageParam }) =>
      listSessions({ limit: pageSize, skip: pageParam as number, ...params }),
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
