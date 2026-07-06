# 2026-07-04 — Hover-prefetch on internal navigation (`<Link>` wrapper)

## What changed

Added a local `Link` wrapper (`src/components/ui/link.tsx`) over `@void/react`'s
`<Link>` that defaults `prefetch` to `"hover"`, and migrated the app's
internal-navigation links to it. On pointer-enter / focus (after the router's
~75 ms hover delay) Void now fetches the target route into its client-side
prefetch cache, so the click commits with no network round-trip.

This is the follow-through on the PR #38 defer/skeleton work: `defer()` moved the
_heavy_ per-page work behind a skeleton, but the skeleton's own paint was still
gated by a full server round-trip on every click (Void navigation re-runs the
middleware chain + loader — it is not a client-cached CSR transition). Prefetch
was **off everywhere** — `@void/react`'s `<Link>` defaults `prefetch: false` and
nothing opted in — so the "preload on hover" we assumed was happening never was.

**Correction (verified 2026-07-04, supersedes an earlier wrong claim in this
file):** a `Purpose: prefetch` request on void 0.10.4 runs the FULL loader and
resolves every `defer()` body server-side, returning a complete JSON page
(`void/dist/pages/protocol.mjs:227-247` — `await resolver(c)`, `deferred: void
0`). So prefetch warms the **whole page, including deferred bodies** — not just
the shell. A normal (non-prefetched) navigation still streams: shell first, then
deferred bodies over NDJSON. `defer()` therefore still matters for the
non-prefetched / cache-cold path (and for the first hover's resolve latency);
for a prefetch cache hit the page commits fully-populated with no skeleton.

### Why a wrapper (not per-link props, not a global switch)

- There is **no global enable** for prefetch. The `voidReact({ prefetch: { … } })`
  config only _tunes_ `hoverDelay` / `cacheFor`; the per-`<Link>` `prefetch`
  default is hardcoded `false` in the runtime (`@void/react` `runtime-*.mjs`:
  `prefetch: prefetchProp = false`). Opt-in must be per-link.
- A single wrapper centralises the policy (matches the "go through `ui/`
  wrappers" convention) and makes it one import swap per file rather than a prop
  sprinkled across ~90 call sites.

The wrapper is a transparent passthrough (same props, no `"use client"` — the raw
`Link` has none either and hydrates fine as part of a regular Void page). It
falls back to no prefetch for non-GET links (Void throws on `prefetch` +
non-GET), and callers can pass `prefetch={false}` to opt out or
`prefetch="visible"` to warm on scroll-into-view.

## Why prefetch works here (hydration)

Prefetch needs client-side hover handlers on each `<Link>`. Confirmed against the
`void@0.10.4` docs/source that this app's pages qualify:

- All dashboard pages are **regular** pages (no `.island` suffix). Regular Void
  pages are **fully hydrated** on the client (`islands.md`: "regular page (full
  hydration, Void Router)"; `overview.md`: "Full SSR HTML. Client hydrates
  automatically."). So every `<Link>` in the tree hydrates and its
  pointer-enter/focus prefetch handlers attach — even in files without
  `"use client"` (those are reserved for genuinely browser-only modules:
  realtime WS rooms, `use-media-query`, live components).
- Prefetch resolves the whole page (see the correction above) — the deferred
  bodies are awaited server-side and cached. Only a normal navigation streams
  the deferred bodies over NDJSON after the shell.

## Details

New file:

| File                                        | Purpose                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/components/ui/link.tsx` | `Link` wrapper; defaults `prefetch="hover"`, GET-only guard, passthrough of all `@void/react` `<Link>` props (`cacheFor`, `viewTransition`, `data`, …). |

Migrated to import `Link` from `@/components/ui/link` (17 files):

- **Reusable nav components (10):** `app-layout` (sidebar), `workspace-switcher`,
  `run-list-row`, `page-header` (breadcrumbs), `flaky-test-row`,
  `analytics/insights-tabs`, `analytics/button-group`, `table-pagination-footer`,
  `run-tests-popover`, `run-progress` (run-detail test list).
- **Tenant pages (7):** `t/[teamSlug]/index`, `…/tests`,
  `…/runs/[runId]/index` (tabs + diff link), `…/runs/[runId]/diff` (base-run
  selector), `…/runs/[runId]/tests/[testResultId]/index`,
  `…/tests/[testId]/index`, `…/insights/slowest-tests`.

`app-layout` and `workspace-switcher` had combined `@void/react` imports
(`Link, useRouter[, useShared]`) — split so the non-Link exports stay from
`@void/react`.

### Intentionally NOT migrated

- **`run-history-chart` (`BarHitbox`) and `run-history-bar-hover`.** Dense
  (~30 bars/chart) _exploratory_ hover surfaces — the user hovers to preview
  (bar-hover already fires a TanStack summary fetch on hover). Stacking a page
  prefetch on every bar-sweep is wasteful server load; left on the raw `Link`.
- **Auth pages** (`login`, `signup`, `reset/forgot-password`, `oops`,
  `not-found`, `index`, `invite`), **settings** (`teams/*`, `keys`,
  `projects*`), and **monitors** pages/forms. Low-value or form CTAs; the
  wrapper is a trivial import swap when we want them.

### Tradeoff to watch

`run-list-row` → run-detail is the heaviest prefetch target (its loader eagerly
scans up to 200 test rows to seed the realtime room, and — per the correction
above — prefetch runs that scan speculatively on hover). Hover-gating (75 ms
delay, only fires on links the user actually points at) bounds the request rate.

**Staleness caveat (verified 2026-07-04, corrects an earlier wrong claim):** the
default `cacheFor` is **`"30s"`** (`@void/react` `plugin.mjs`:
`prefetch.cacheFor ?? "30s"` → stale = expires = 30 s), i.e. a **30-second reuse
window** — NOT single-use. So a prefetched entry can be committed up to 30 s
after the hover. On the **realtime-seeded** pages (run-detail, runs list) that
means a click can commit a seed up to 30 s stale; it is then reconciled by the
room events + `useRunRoom` backfill + reconnect-refresh, but an in-flight run
can briefly show stale rows. For a terminal run it is a non-issue. Options if
this matters: a short explicit `cacheFor="5s"` on realtime-page-bound links
(NOT `cacheFor={0}` — that makes the entry `singleUse`, which never expires).
The app sets no global `voidReact({ prefetch })`, so the 30 s default is in
effect everywhere today.

## Verification

- `pnpm check` (oxfmt + oxlint + type-aware type-check): **0 errors**, 120
  warnings — all pre-existing `no-unsafe-*` warnings in `packages/reporter`,
  `packages/e2e`, and unrelated `src/lib` files; **none in the touched files**.
- Ran `void prepare` first (fresh worktree had no `.void/` codegen → an
  `Invalid tsconfig` error unrelated to this change).
- Runtime confirmation (observing a prefetch request fire on hover in
  devtools, and the shell painting instantly on the subsequent click) is left to
  a manual pass with `pnpm dev`.

## Related / follow-ups (from a parallel research pass)

- **Keep page reads server-side.** Moving loader reads to client-side TanStack
  Query would re-pay auth on the API routes, duplicate the tenant-scoped SQL, and
  break the run-detail realtime seed. The right levers are prefetch (this change)
  - finishing `defer()`, not client fetching.
- **More loaders still do all-eager work** and are good next `defer()`
  candidates: `settings/…/usage`, `settings/…/billing`, `monitors/index`,
  `monitors/[monitorId]`, and `tests/[testId]` (awaits a 4-way `Promise.all`
  before any paint). Caveat: a deferred prop that a same-page action mutates
  shows stale data after the mutation — keep action-bearing settings lists eager.
- `viewTransition` on `<Link>` (already a supported prop, now flowing through the
  wrapper) is an available polish lever, unused today.
