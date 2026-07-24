import { useSyncExternalStore } from "react";
import { useRouter } from "@void/react";
import { useNavigate } from "@/lib/navigate";

/**
 * URL search-param state for Void pages.
 *
 * Void's router (`router.visit`) is Inertia-style: every URL change re-runs
 * the page loader. There's no shallow primitive on the router, so for URL
 * state that should NOT trigger a re-fetch (active tab, dialog mode, etc.)
 * we fall back to the History API directly.
 *
 * Two hooks, identical read API, different write behaviour:
 *
 * - `useSearchParam` — shallow updates via `history.replaceState`. Use when
 *   the URL just mirrors client state and the page already has the data.
 * - `useNavigatingSearchParam` — writes route through `router.visit()`. Use
 *   when changing the value should re-run the page loader (filters that
 *   change what rows the server returns).
 *
 * Multiple consumers of the same key stay in sync via a shared listener
 * set: shallow writes call `notify()` because `history.pushState` /
 * `replaceState` don't fire `popstate`. `router.visit()` causes Void to
 * re-render the page, which picks up the new URL on its own.
 */

const listeners = new Set<() => void>();
let popstateBound = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!popstateBound && typeof window !== "undefined") {
    window.addEventListener("popstate", notify);
    popstateBound = true;
  }
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const l of listeners) l();
}

function getSnapshot(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function useUrlSearch(): string {
  // On SSR, Void's RouterContext exposes the request URL via `router.query`.
  // On the client, `useSyncExternalStore` uses `window.location.search`
  // and re-runs whenever a shallow write notifies or popstate fires.
  const router = useRouter();
  const qs = router.query.toString();
  const serverSearch = qs ? `?${qs}` : "";
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSearch);
}

function buildUrl(key: string, next: string | null): string {
  const params = new URLSearchParams(window.location.search);
  // A `null` next (or a write back to the default, handled by the callers)
  // removes the key entirely, so idle/closed state doesn't leave a bare
  // `?key=` dangling in the URL.
  if (next === null) params.delete(key);
  else params.set(key, next);
  const qs = params.toString();
  return (
    (qs ? `${window.location.pathname}?${qs}` : window.location.pathname) +
    window.location.hash
  );
}

/** Drop the key when the value returns to its default; otherwise set it. */
function normalizeNext(next: string, defaultValue: string): string | null {
  return next === defaultValue ? null : next;
}

export function useSearchParam(
  key: string,
  defaultValue: string,
): [string, (next: string) => void] {
  const search = useUrlSearch();
  const value = new URLSearchParams(search).get(key) ?? defaultValue;
  const set = (next: string): void => {
    if (typeof window === "undefined") return;
    window.history.replaceState(
      window.history.state,
      "",
      buildUrl(key, normalizeNext(next, defaultValue)),
    );
    notify();
  };
  return [value, set];
}

export function useNavigatingSearchParam(
  key: string,
  defaultValue: string,
): [string, (next: string) => void] {
  const search = useUrlSearch();
  const navigate = useNavigate();
  const value = new URLSearchParams(search).get(key) ?? defaultValue;
  const set = (next: string): void => {
    if (typeof window === "undefined") return;
    navigate(buildUrl(key, normalizeNext(next, defaultValue)), {
      history: "replace",
    });
  };
  return [value, set];
}
