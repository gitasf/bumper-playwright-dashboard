import { useNavigation } from "@void/react";

/**
 * True while a Void page navigation is in flight — a link visit or a
 * filter-driven `router.visit()` that has started but whose shell has not
 * committed yet.
 *
 * Header filter controls that each start a navigation (the range/group
 * segmented links, sort column headers, tag chips, the branch combobox) use
 * this to go inert until the current visit settles. Starting a second visit
 * while one is still in flight aborts the pending one and rejects its
 * still-loading deferred props, which surfaces as an uncaught "Navigation
 * disposed before deferred props resolved" error when a user switches filters
 * quickly.
 *
 * SSR-safe: `@void/react`'s `NavigationContext` defaults to the idle state, so
 * this returns `false` on the server and during the initial client render.
 */
export function useIsNavigating(): boolean {
  return useNavigation().state !== "idle";
}
