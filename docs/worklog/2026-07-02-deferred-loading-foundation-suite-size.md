# 2026-07-02 — Deferred-loading foundation + suite-size exemplar

## What changed

First use of Void's `defer()` in the dashboard, to cut **perceived** page-load
time: a page's shell (header, tabs, filters) paints immediately from cheap eager
data, and each heavy query streams in behind a skeleton over the same
SSR/SPA-nav response (no extra HTTP request). This lands the shared foundation
plus the first page (`insights/suite-size`) as the reference implementation for
a wider rollout.

Deferred loading is a **read-path, perceived-load** tool only — it does not
reduce total server work, and it must not be applied to the per-request tenant
middleware baseline (already a single indexed join) or to data a same-page form
mutates (deferred props can't stream over a mutation/action response). Those
guardrails are baked into the pattern below.

### The pattern (established here, for the rollout to follow)

1. **Loader** keeps the shell eager and wraps each slow, below-the-fold,
   non-mutated prop in `defer(async () => …)`. Props derived from one slow query
   (or a dependency chain) go in a single grouped resolver so they can't tear;
   independent slow regions get separate `defer()`s so a slow one never gates a
   fast one.
2. **Page** reads each deferred prop with React `use()` inside a small child
   component, wrapped in `<DeferredSection skeleton={…}>` (which pairs
   `Suspense` with an error boundary so a rejected resolver degrades to a scoped
   card instead of blanking the page). Any derivation of the deferred value
   (`alignBuckets`, KPI assembly, empty-state checks) moves into that child.
3. **Skeletons** build on the existing `Skeleton` primitive and mirror the real
   box so streamed data causes no layout shift.

## Details

| File                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/defer-error-boundary.tsx`                          | **New.** `DeferErrorBoundary` (client class boundary; catches deferred-resolver rejections thrown from `use()`, with a `resetKey` that clears a latched error on filter-change SPA nav since Void reuses the page component across navigations) + `DeferredSection` convenience wrapper (Suspense + boundary in one, so the error boundary can't be forgotten) + a default muted error card.                                                                                                                                                                                                                                        |
| `src/components/skeletons.tsx`                                     | **New.** Reusable Suspense fallbacks — `KpiCardSkeleton` (mirrors `AnalyticsKpiCard` chrome), `ChartSkeleton` (reserves chart height), `ListRowsSkeleton`. Page-specific shapes stay inline.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pages/t/[teamSlug]/p/[projectSlug]/insights/suite-size.server.ts` | Loader now returns the shell eager (`project`, range/segment params, `branches`) and defers three regions: `trend` (grouped: `trendRows` + derived `peakOverall` + `kpis` — KPI assembly stays server-side), `testsAdded` (the heaviest pass — distinct scan + project-wide `NOT EXISTS` — on its own boundary so it never gates the trend cluster), and `distribution` (grouped `fileRows` + `tagRows` + `fileTotal`). Removed the now-dead `earliestQuery`: this page's ranges are all bounded (no `"all"`), so `rangeSec` is never null and `shellStartSec = windowStartSec` (invariant documented in `resolveAnalyticsWindow`). |
| `pages/t/[teamSlug]/p/[projectSlug]/insights/suite-size.tsx`       | Split the flat presenter into eager shell + child components (`TotalTestsKpi`, `TestsAddedKpi`, `NetChangeKpi`, `TrendChart`, `DistributionSection`) each read via `use()` under a `DeferredSection`. KPI grid uses per-cell boundaries so the two trend-backed cards resolve together (same deferred promise) while "Tests added" resolves independently. Chart card chrome + title stay eager; only the chart body defers.                                                                                                                                                                                                        |

Behaviour is otherwise unchanged: same queries, same KPI/metric definitions
(still computed server-side), same SWR `Cache-Control`, same rendered output
once resolved. Only the _timing_ of when each region appears changes.

## Verification

- `vp check` (format + lint + type-aware typecheck) — **0 errors**; the three
  new/changed files are clean. (The 92 lint warnings are pre-existing in
  unrelated files, e.g. `src/lib/error-cause.ts`.)
- `tsgo --noEmit` after `void prepare` — **0 errors**. Confirmed `InferProps`
  types the three `defer()` returns as `Deferred<T>` and `use()` unwraps them.
- **Runtime (dev server, human-verified):** shell paints immediately, all three
  skeletons show, and the three regions stream in and resolve correctly (the
  streamed NDJSON payload contains fully-resolved `trend` / `testsAdded` /
  `distribution`). Two issues surfaced and were run down (below).

## Runtime findings & fixes

### 1. Document navigation downloaded an NDJSON file (fixed)

**Symptom:** the first few navigations to the page downloaded a file instead of
rendering.

**Cause:** a deferred loader's response is **streamed** — `application/x-ndjson`
on SPA nav, chunked `text/html` on a document load — and Void keys the two
variants with `Vary: X-VoidPages` (`void/dist/pages/protocol.mjs`). This loader
was still sending `Cache-Control: private, max-age=300,
stale-while-revalidate=900` (fine when it returned a single non-streamed
response). Caching a streamed, variant-specific response lets the browser replay
the wrong variant — the cached NDJSON payload served for a top-level navigation
downloads as a file. The bug only became visible with `defer()` because the SPA
variant is now `application/x-ndjson` (a download-triggering type) rather than
`application/json`.

**Fix:** deferred pages set `Cache-Control: private, no-store` — a streamed,
tenant-scoped, variant-specific response must not be stored. The perceived-load
win now comes from streaming, not the cache. **This is a rollout rule: any page
we convert to `defer()` must drop its SWR/`max-age` cache header.**

### 2. Console: "The server could not finish this Suspense boundary… Switched to client rendering" (accepted — inherent to Void)

Not caused by our code. For a deferred page Void replaces the deferred props with
never-resolving promises, renders the shell (Suspense boundaries show their
skeletons), emits a `<template>` shell-end marker, then **aborts** the SSR stream
(`readDeferredShell` → `reader.cancel(DEFERRED_SHELL_CANCEL_REASON)` in
`@void/react/dist/runtime/pages-server.mjs`) and streams the real data
separately. React reports each aborted-while-pending boundary as a _recoverable_
error on hydration, and Void's `hydrateRoot` passes no `onRecoverableError` to
silence it. It is recoverable — the page renders and the regions resolve — so
this is benign console noise intrinsic to Void 0.9.2's deferred SSR, reproducible
by any deferred page regardless of the error boundary. `ssr = false` is not
available in 0.9.2 (a 0.10.x feature) and would forfeit shell SSR anyway;
accepted as-is.

### 3. Base UI `useId` hydration mismatch on the eager shell (fixed via Void patch)

**Symptom:** on deferred pages only, React logged a hydration mismatch on Base UI
component ids (`base-ui-_R_…`) for the eager sidebar popovers and branch-filter
combobox — "won't be patched up". Not present on non-deferred pages.

**Root cause (dedicated debug agent, confirmed with a real `react-dom@19.2.7`
repro + arithmetic proof):** `@void/react` renders a deferred page as
`<Fragment>{page}<template id=…SHELL_END/></Fragment>` (page = child 0 of 2), so
React Fizz's `useId` tree-context forks and adds 2 low-order bits to **every** id
in the page. Then `readDeferredShell` **strips** that marker from the HTML and the
client `hydrateRoot`s a **bare** single root child (no fork) — so the client
computes unforked ids. Signature holds exactly on all three captured pairs:
`serverId === (clientId << 2) | 0b01`. It is tree **shape** asymmetry, not Suspense
timing — which is why it appears only with `defer()`. Non-fatal (React keeps the
server ids until a re-render; Base UI wires aria via refs), but real console noise.
Upgrading Void does **not** fix it — 0.10.3 has the identical wrapper.

**Fix:** `patches/@void__react@0.9.2.patch` (wired into root `package.json`
`patchedDependencies`; joins the existing `void@0.9.2` pg-pool patch and the CF
vite-plugin patch). Two coordinated one-liners make the server/client root trees
id-isomorphic: (a) `readDeferredShell` keeps the marker in the emitted HTML
(`slice(0, markerIndex + MARKER.length)`); (b) `startReactPages` wraps the app in
the same `<Fragment>{app}<template id=…SHELL_END/></Fragment>` **when the marker is
present in `#app`** (non-deferred pages have no marker → bare hydrate, unchanged).
Verified: `vp build` bundles the patched runtime cleanly, `tsgo` 0 errors. Worth
upstreaming to Void. **This patch is version-pinned to 0.9.2 and must be re-ported
on any Void upgrade** (as must the pg-pool patch, which 0.10.3 does not include).

### 4. Deferred pages full-reloaded on SPA navigation (fixed via Void patch)

**Symptom:** navigating to a deferred page (e.g. an insights page) did a full
browser reload instead of a smooth client-side nav.

**Cause (Void core bug):** the client router (`void/dist/pages/client.mjs`) only
does a client-side navigation when the fetched response carries an `X-VoidPages`
header; without it, it falls back to `window.location.href` (full load). The
normal SPA-nav response (`pageJsonResponse`) sets `X-VoidPages` + `Vary`, but the
**deferred `application/x-ndjson` response (`streamDeferredResponse` in
`void/dist/pages/protocol.mjs`) omitted it** — so every deferred page hard-navigated.
Independent of our `no-store` / `useId` changes.

**Fix:** folded into `patches/void@0.9.2.patch` (which now patches **both**
`dist/index.mjs` — the pre-existing pg-pool fix — and `dist/pages/protocol.mjs`):
`streamDeferredResponse` sets `{ "X-VoidPages": "true", Vary: "X-VoidPages" }` when
`isPagesRequest(c)` is true, mirroring `pageJsonResponse`. Keyed on the **request**
(the `X-VoidPages` request header Void itself uses to decide pages-vs-document) —
not on the response content-type, which would be a brittle proxy. The `text/html`
document-load variant is a full navigation (`isPagesRequest` false), so it
correctly omits the header. Verified: `vp build` + `tsgo` clean. Also worth upstreaming.

**Net:** Void 0.9.2's `defer()` requires two framework patches to work smoothly —
`void@0.9.2` (pg-pool + `X-VoidPages`) and `@void__react@0.9.2` (`useId`) — plus
the `no-store` loader rule. Both are version-pinned and must be re-ported on any
Void upgrade.

## Rollout progress

Beyond the `suite-size` exemplar, two more High-impact pages were converted with
the same pattern + rollout rules:

- **`insights/slowest-tests`** — `branches`/`totals` eager; deferred `histogram`
  (own boundary) + grouped `slowest` (bottlenecks → sparklines dependency chain);
  the two p95 KPIs moved into the deferred children; `Cache-Control` → `no-store`.
- **`runs/[runId]` (run detail)** — deferred only the below-fold `chart`
  (history + branches). **`tests` kept eager on purpose:** it seeds the
  `useRunRoom` realtime island via `useSeededState`, which reseeds by reference
  and would discard folded WS events (and rooms have no replay), so deferring it
  would drop live updates. `run` stays eager (404 gate + island seed).

Medium-impact pages (`flaky`, `insights/index`, `run-duration`, `runs/[runId]/diff`,
the single test-result page, settings audit) remain to be converted.
