# 2026-07-04 — fate (fate.technology) data-layer spike + evaluation (declined)

## What changed

Nothing in the committed codebase. This entry records a **time-boxed spike** that
evaluated adopting [fate](https://fate.technology/) (`react-fate` / `void-fate` /
`@nkzw/fate`, nkzw-tech) as the dashboard's data-fetching layer in place of the
Void loader + RSC model (and the small TanStack Query surface). The spike was
built, evaluated, and **removed**. The decision: **do not adopt fate.** This
worklog exists so the decision — and specifically _why_ — is not re-litigated.

fate is a Relay/GraphQL-inspired normalized-cache client: co-located `view`s
(≈ fragments) compose to a single request per screen, with data masking, a
normalized cache keyed by `__typename:id`, `useView`/`useRequest`/`useListView`
reads, `fate.actions`/`fate.mutations` writes (optimistic + rollback), and live
views over SSE. It ships a first-class Void adapter (`void-fate`) and a Drizzle
source adapter, which is why it was worth a real spike rather than a paper no.

## The spike

Installed `void-fate@1.3.1` + `react-fate@1.3.1` + `@nkzw/fate@1.3.1` into
`apps/dashboard` and implemented the **test-detail read path**
(`runs/[runId]/tests/[testResultId]`) the fate way — the most entity-shaped
non-realtime page, chosen because it exercises fate's best case (an entity +
a bounded child list + field masking):

- `src/fate-spike/views.ts` — `dataView`s for `TestResult` / `TestAttempt`, `Root`.
- `src/fate-spike/server.ts` — scoped Drizzle source + `createFateServer` with a
  tenant-scoped list resolver and a guarded by-id query.
- `src/fate-spike/test-detail.client.tsx` — client page (`view` + `useView` +
  `useListView` + `useRequest`).

Ground-truth API was read from the installed `.d.mts` files (not docs, which lag
the 1.3.x releases).

## Verification (what was actually run)

- **Version compat: OK.** `drizzle-orm@0.45.2` (fate needs `^0.45.0`), `vite@8`,
  `react@19.2.7`, `void@0.10.4` all satisfy fate's peers. `void-fate` declares
  peer `void@^0.7.13` (i.e. built for Void 0.7.x); pnpm warned but resolved to
  0.10.4. void-fate only imports `defineHandler` + `TypedHandler` from `void`,
  both present/compatible in 0.10.4 — so the stale peer is cosmetic, not a break.
- **Typecheck (`tsgo --noEmit`): baseline green.** The whole dashboard (incl. the
  20 in-flight deferred-loading files) typechecks; the only errors introduced
  were fate's. After manual resolver-arg annotations, `server.ts` compiled clean.
  The client page has **3 residual, unfixable-without-codegen errors** (see below).
- **No live run.** `database: "pg"` + the known `vp dev` block (see
  `project_dev_reads_generated_wrangler_nodejs_compat`) means the app can't boot
  here, so runtime behaviour was not observed. Full Vite-plugin wiring +
  `vp build` was deliberately NOT done — it is app-wide and reintroduces
  `void/live` (below), and the verdict was already determined.

## Why fate was declined

Genuine upsides (real, but narrow for this app):

- **Data masking** formalizes "don't serialize `r2Key`/tokens / gate by role"
  (today done by hand in the loader) — the strongest fit on this page.
- **Client-side nav caching** (cache-first / SWR) → instant revisits; the
  "feels like an app" quality a loader-per-navigation model lacks.
- **Fine-grained mutation invalidation** (optimistic + normalized) vs. today's
  `router.refresh()` full-loader re-run.

Decisive downsides for a multi-tenant, aggregate-heavy, server-rendered app:

1. **Tenant-isolation regression (the deciding factor).** Our security model
   (`src/lib/scope.ts`) makes an unscoped query a _compile error_ via the branded
   `AuthorizedProjectId`. fate offers no equivalent: (a) no source-level
   "always-apply-this-where"; (b) auto-generated `byId`/`list` procedures apply
   **no** tenant filter (exposing them leaks across projects); (c) the Drizzle
   adapter **silently drops `extra.where` on the by-id path**, so the obvious way
   to scope a by-id fetch does nothing — you must hand-write a second guard query;
   (d) `createFateServer<Ctx>` doesn't infer resolver args, so `ctx` (hence
   `scope`) is `any` in resolvers — zero type-level help that you scoped at all.
   Net: safe-by-construction → unsafe-by-default with a live footgun.
2. **Aggregates aren't entities.** The heaviest reads (flaky, insights,
   run-duration, slowest-tests) are `GROUP BY` / percentile / window-function SQL,
   not `byId`/`list`. They'd become custom fate resolvers running the identical
   SQL — fate's normalization/masking/dedup never reaches them.
3. **Invasive wiring that reverses a prior decision.** Adoption touches
   `vite.config.ts` (the `react-fate/vite` codegen plugin), the root layout
   (`VoidFateClient` provider), and adds `routes/fate.ts` + `routes/fate-live.ts`.
   `defineVoidFateRoute` requires a live stream via **`void/live` (SSE)** — i.e.
   it **reintroduces the `void/live` dependency + VOID_LIVE DO deleted on
   2026-06-07** (`2026-06-07-delete-sse-realtime.md`). Realtime is `void/ws` rooms
   by design (WS hibernation avoids the DO-duration cost SSE incurs).
4. **Loaders don't disappear.** SSR needs manual `dehydrate()`/`hydrate()`
   threaded through loaders you keep, plus net-new tenant-scope re-derivation at
   the tenant-less global `/fate` endpoint.
5. **Codegen-gated client.** `react-fate/client`'s `createFateClient` is a
   `never` stub; the real typed client + `Roots` types are generated by the Vite
   plugin. The client page cannot typecheck without it (the 3 residual errors) —
   a Relay-style build step the "no magic, just JS" pitch downplays.
6. **Maturity.** All three packages' own getting-started docs still say
   "alpha / not production ready" (despite the "fate 1.0 is production-ready"
   blog post); single maintainer; Void peer pinned to 0.7.x while we're on 0.10.4.

## Outcome

Spike removed; `apps/dashboard/package.json` + `pnpm-lock.yaml` restored,
`node_modules` pruned. Recommendation stands: **keep Void loaders + `defer` for
reads, Void actions for writes, `void/ws` rooms for realtime, and the small
TanStack Query surface for interaction-gated client reads.** Revisit fate only
for a future greenfield, client-heavy, single-tenant surface — not this app.
