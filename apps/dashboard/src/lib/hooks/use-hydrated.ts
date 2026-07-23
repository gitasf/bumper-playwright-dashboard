"use client";

import { useSyncExternalStore } from "react";

// Module-level so the subscription identity is stable across renders —
// `useSyncExternalStore` re-subscribes whenever the `subscribe` reference
// changes, and hydration status never changes after mount, so there's
// nothing to subscribe to.
const emptySubscribe = () => () => {};

/**
 * Returns `false` during SSR and the pre-hydration client render, then
 * `true` once React has hydrated. Backed by `useSyncExternalStore` (React's
 * documented primitive for reading a value that legitimately differs between
 * server and client) rather than the `useState` + `useEffect` idiom, so
 * flipping to `true` happens as part of the hydration commit instead of a
 * separate effect-triggered re-render.
 *
 * Used to gate client-only submit paths — e.g. the auth pages disable
 * submit until hydrated so a pre-hydration native form submit can't GET the
 * page with credentials in the query string.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
