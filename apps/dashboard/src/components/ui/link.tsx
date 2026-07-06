import { Link as VoidLink } from "@void/react";
import type { ComponentProps } from "react";

export type LinkProps = ComponentProps<typeof VoidLink>;

/**
 * `cacheFor` preset for stable, non-realtime pages (insights, tests catalog,
 * flaky, test detail): stale-while-revalidate — a prefetched entry commits
 * instantly for 30s, then serves-stale-while-revalidating up to 5m, so back /
 * tab navigation between these pages feels instant. Do NOT use on
 * realtime-seeded pages — their loader props seed `useRunRoom` /
 * `useProjectRoom`, and a stale committed seed would show outdated rows until
 * the room reconciles.
 */
export const PREFETCH_STABLE: [string, string] = ["30s", "5m"];

/**
 * `cacheFor` preset for realtime-seeded pages (run detail, runs list): a short
 * window so a click still reuses a just-made hover-prefetch, but the committed
 * seed is never more than a few seconds stale (the room + `useRunRoom` backfill
 * reconcile the rest). Tighter than the 30s global default, which could commit a
 * 30s-stale realtime seed.
 */
export const PREFETCH_REALTIME = "5s";

/**
 * App-wide navigation link — a thin wrapper over `@void/react`'s `<Link>` that
 * defaults `prefetch` to `"hover"`.
 *
 * On pointer-enter / focus (after the router's ~75ms hover delay) Void fetches
 * the target route into its client-side prefetch cache, so the click commits
 * with no network wait. NOTE: a `Purpose: prefetch` request runs the FULL
 * loader and resolves every `defer()` body server-side — Void returns a
 * complete JSON page (deferred stripped; see `void/dist/pages/protocol.mjs`) —
 * so hovering a link to a heavy/deferred page runs those queries speculatively.
 * A normal (non-prefetched) navigation still streams: shell first, then
 * deferred bodies over NDJSON.
 *
 * Cache reuse: the default `cacheFor` is a 30s window (voidReact's
 * `prefetch.cacheFor ?? "30s"`), so a prefetched entry is reused for repeat
 * clicks within 30s — it is NOT single-use. Pass `cacheFor` to tune, e.g.
 * `["15s","5m"]` for stale-while-revalidate on stable pages, or a short `"5s"`
 * on links to realtime-seeded pages where a stale committed seed matters.
 *
 * Prefetch is GET-only (Void throws on non-GET), so links with a mutating
 * `method` fall back to no prefetch. Pass `prefetch={false}` to opt a link out
 * (e.g. dense/expensive lists you don't want warmed on every hover), or
 * `prefetch="visible"` to warm on scroll-into-view (aggressive — runs the full
 * loader for every row that scrolls in).
 *
 * Prefer this over importing `Link` from `@void/react` directly for internal
 * navigation.
 */
export function Link({ prefetch, method, ...props }: LinkProps) {
  const isGet = (method ?? "GET").toUpperCase() === "GET";
  return (
    <VoidLink
      {...props}
      method={method}
      prefetch={prefetch ?? (isGet ? "hover" : false)}
    />
  );
}
