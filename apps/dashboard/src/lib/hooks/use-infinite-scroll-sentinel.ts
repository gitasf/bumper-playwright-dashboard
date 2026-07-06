"use client";

import { type RefObject, useEffect, useRef } from "react";

/** The paging fields this hook reads off a TanStack `useInfiniteQuery` result. */
interface InfiniteScrollQuery {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * Load-more-on-scroll wiring for an infinite list, in one place. Attach the
 * returned ref to a sentinel element at the end of the list; when it scrolls
 * into view (and a fetch isn't already in flight) the next page is requested.
 * `enabled` gates observation entirely — pass a group's `open` state so a
 * collapsed group's sentinel does nothing.
 *
 * Extracted so the IntersectionObserver lifecycle (create / observe / disconnect
 * on cleanup, re-created when the fetching flag flips so its closure stays fresh)
 * lives in exactly one place instead of being hand-rolled per list.
 */
export function useInfiniteScrollSentinel(
  query: InfiniteScrollQuery,
  enabled = true,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (!enabled || !hasNextPage) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) {
        fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, hasNextPage, isFetchingNextPage, fetchNextPage]);
  return ref;
}
