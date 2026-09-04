import { useInfiniteQuery } from "@tanstack/react-query";
import { getSessionTranscript, type TranscriptResponse } from "../api/generated";
import { useUserSettings } from "../api/model";

/**
 * Wraps `useInfiniteQuery` over `GET /api/sessions/{id}/transcript`, accumulating
 * disjoint `offset` pages as the reader scrolls.
 *
 * This replaces a viewer that pinned `offset: 0` and grew `limit` instead. That read
 * as incremental — react-query's `placeholderData` kept the old entries on screen —
 * but every "load more" re-fetched the whole prefix from the gateway, so reaching
 * entry 2 000 in pages of 100 moved two hundred thousand entries over the wire. Real
 * paging asks for each block once and lets the cache keep it.
 *
 * The page size is deployment config (`userSettings.transcriptPageSize`).
 */
export function useInfiniteTranscript(sessionId: string) {
  const { transcriptPageSize: pageSize } = useUserSettings();

  const query = useInfiniteQuery<TranscriptResponse>({
    // The page size is part of the identity of these pages: changing it must start a
    // fresh read rather than append differently-sized pages onto the cached ones.
    queryKey: ["/api/sessions", sessionId, "transcript", "infinite", pageSize],
    queryFn: ({ pageParam }) =>
      getSessionTranscript(sessionId, { offset: pageParam as number, limit: pageSize }),
    initialPageParam: 0,
    // `hasMore` is per-page and the gateway also reports `totalCount`; count what we
    // hold rather than trusting a flag computed against a corpus that may still be
    // growing under a live session.
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.entries.length, 0);
      if (lastPage.entries.length === 0) return undefined;
      return loaded < lastPage.totalCount ? loaded : undefined;
    },
    enabled: Boolean(sessionId),
  });

  const first = query.data?.pages[0];
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  return {
    entries,
    totalCount: first?.totalCount ?? 0,
    /** Which store answered — `chunks` is live and still growing, `s3` is finalised. */
    source: first?.source,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  };
}
