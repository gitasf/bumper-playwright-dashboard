# 2026-07-04 — Run-detail Tests tab: paginate by group, chips from the live summary

## What changed

The run-detail **Tests tab** used to load the _entire_ run into memory: the SSR
loader seeded the first 200 test rows, then `useRunRoom`'s `backfill` effect
back-paginated **every** remaining page (200–500 rows each) from `GET /results`
into a client `byId` accumulator, and the component derived both the row list
**and** the filter-chip counts (All/Failed/Flaky/Passed/Skipped) from that
growing set. On a 2000-test run this fired ~10 sequential requests and the chip
counts visibly ticked 200 → 2000 as each page landed — flooding Postgres and the
network for data the user mostly never scrolled to.

This reworks the tab into a **two-level, paginate-by-group** read that matches
how the UI actually reads the data:

1. **Filter chips → the live run summary.** The `runs` row already stores
   live-accurate `totalTests/passed/failed/flaky/skipped` (incremented per ingest
   batch, broadcast on the `void/ws` `progress.summary`). The chips now read that
   (`currentSummary`) instead of counting loaded rows — instant, whole-run-correct,
   live, **zero row reads**. The bucket math is identical (`STATUS_BUCKET_MEMBERS`
   is derived from the same `STATUS_BUCKETS` the chips collapse by), and
   `totalTests === count(*)` holds at every point of a run (the prefill seeds
   `totalTests = plannedTests.length` to match the inserted queued rows).

2. **Group headers → a server "skeleton".** `loadRunGroupSkeleton` runs one
   `GROUP BY <axis>` (`file` / `projectName` / `shardIndex`) with
   `count(*) FILTER (WHERE status IN <bucket>)` per bucket and a
   `failed*4 + flaky*2` severity, ordered worst-first in SQL. It reuses
   `STATUS_BUCKET_MEMBERS` / `statusMatchSql` so the header counts can't drift
   from the run-level aggregate. Rides the existing `(projectId, runId)` index;
   group cardinality is small (~100 files) so the aggregate is cheap. Fetched via
   TanStack `useQuery`; changing the group-by axis / status chip / search
   re-fetches it **server-side** (search is a trigram-backed `ILIKE` on
   title+file).

3. **Rows → lazy, per expanded group.** `loadRunResultsPage` gained an optional
   `group: {axis,key}` + `statusBucket` + `search` predicate; the `(createdAt,id)`
   cursor is unchanged (stable). Each expanded group is a `useInfiniteQuery`
   (infinite-scroll for a huge group) whose rows merge on top of the live `byId`
   overlay and sort worst-first client-side. Collapsed groups cost nothing but
   their header.

The SSR loader now returns the skeleton + the first row page of the
auto-expanded worst groups (server-flagged `expandedByDefault`) — one initial
fetch, everything else on interaction.

### Live behaviour

Chips update from the streamed `summary`. Group headers/order stay correct by
refreshing the (cheap) skeleton **while the run is running**, on an event-driven
**throttle** (at most once per `LIVE_STALE_MS`; a trailing debounce would starve
under a burst and a fixed interval would poll forever on a missed terminal
event), plus one final refresh when the run flips terminal, plus a query
invalidation on WS reconnect (the reseed empties the `byId` overlay, and the Void
loader refresh doesn't touch TanStack caches). Terminal runs cache their skeleton

- rows indefinitely (`staleTime: Infinity`). Rows in expanded groups update
  through the `byId` overlay and render in the server's `(createdAt, id)`-desc
  order (id-desc client sort) so infinite-scroll pages never reorder above the
  viewport. The old eager back-paginate loop is gone.

Auto-expand is a one-shot latch on the server's `expandedByDefault` flag; a run
watched live from empty waits for the first failed/flaky group before latching
(so a passing fallback expansion can't consume the latch and hide later
failures) — the guard the old client engine had, preserved.

### Why on-the-fly and not a materialized rollup

A per-`(run, axis, groupKey)` rollup table was considered and **deliberately
deferred**: it would add a second delta path to the hot ingest transaction, a
membership-drift correctness surface (the `/results` upsert can rewrite
`file`/`shardIndex`), 3-axis write amplification, and prefill-seeding
complexity — to win only for very large runs _watched live by many viewers_, a
speculative audience. The on-the-fly aggregate is correct-by-construction and
touches ingest zero. `loadRunGroupSkeleton` is the seam a rollup would slot
behind unchanged (same signature + `RunGroupSkeleton` shape) if telemetry ever
shows large live runs hurting; `MAX_RUN_GROUPS` logs the breach that would
signal it.

## Details

| File                                     | Change                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/run-groups-page.ts`             | **New.** `loadRunGroupSkeleton`, `groupAxisColumn`, `groupPredicate` (null→`IS NULL` / empty-file), `testSearchPredicate`, `RunGroupSkeleton`/`RunGroupHeader`, `MAX_RUN_GROUPS`.                                                                                                       |
| `src/lib/run-results-page.ts`            | `LoadRunResultsOpts` gained `group`, `statusBucket`, `search`, `skipOwnershipCheck`. Cursor untouched.                                                                                                                                                                                  |
| `src/lib/ingest.ts`                      | Exported `statusMatchSql` (reused by the skeleton + row bucket filter).                                                                                                                                                                                                                 |
| `src/lib/group-tests-by-file.ts`         | Added `rawGroupKey` / `groupKeyId` / `groupLabel` (server↔client group-key contract); **removed** the now-dead client group engine (`groupAndSortTests`/`countByStatusGroup`/`selectDefaultExpandedKeys`/`groupKeyFor`/`groupSeverityScore`/`severityOf`) the server skeleton replaced. |
| `routes/api/.../runs/[runId]/groups.ts`  | **New** GET route → `loadRunGroupSkeleton`.                                                                                                                                                                                                                                             |
| `routes/api/.../runs/[runId]/results.ts` | Added `groupBy`/`groupKey`/`statusBucket`/`search` query params.                                                                                                                                                                                                                        |
| `pages/.../runs/[runId]/index.server.ts` | Loader seeds skeleton + auto-expanded group row pages (parallel) + `isSharded` (from `run.expectedShards`); dropped `tests`/`testsCursor`.                                                                                                                                              |
| `pages/.../runs/[runId]/index.tsx`       | Passes the new props to `RunProgress`.                                                                                                                                                                                                                                                  |
| `src/components/run-progress.tsx`        | Rewrite: chips from summary; headers from the skeleton `useQuery`; per-group rows via `useInfiniteQuery` + `byId` overlay; throttled live skeleton refresh + terminal + reconnect invalidation; one-shot server-driven auto-expand with the live-from-empty guard.                      |
| `src/realtime/use-run-room.ts`           | Removed the eager back-paginate loop + `backfill` option; keeps summary + live `byId`. (`mergeBackfilledTests` removed from `run-progress.ts`.)                                                                                                                                         |

No schema change, no migration.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm check` (vp check: oxfmt + oxlint + type-aware) — **0 errors** (121
  pre-existing warnings, all in `packages/e2e` fixtures, untouched).
- `pnpm --filter @wrightful/dashboard test` (both lanes) — **239 + 1125 passed**
  (workers count is down from 1145 because the dead-code removal took ~20
  now-orphaned unit tests with it).
- New tests:
  - `pg-integration.test.ts` → a `run-group skeleton (grouped read)` block that
    executes `loadRunGroupSkeleton` + the group-filtered `loadRunResultsPage`
    against real Postgres SQL (pglite/node-postgres): worst-first ordering,
    per-bucket counts (`timedout ∈ failed`), `expandedByDefault`, status + search
    filters, the shard/null-key fallback, and the int8→number coercion.
  - `group-tests-by-file.workers.test.ts` → `rawGroupKey` / `groupKeyId` /
    `groupLabel` pin the server↔client group-key contract.
- **Not run here (flag for follow-up):** the dashboard Playwright suite
  (`pnpm --filter @wrightful/e2e test:dashboard`). `run-detail.spec` +
  `realtime.spec` should still pass (row-link selector unchanged; the realtime
  results all share `live.spec.ts` → one auto-expanded group, so the 0→3 count
  holds via the `byId` overlay + debounced refetch within Playwright's retry).
  `visual.spec`'s `run-detail.png` baseline may need `--update-snapshots` if the
  Tests-tab render shifted.

### Adversarial review + fixes applied

An 8-angle review of the diff (correctness / removed-behavior / cross-file / SQL
/ live-realtime / reuse / altitude / conventions) ran before finalizing. SQL and
cross-file passes were clean (aggregates coerced, injection-safe, all callers
survive the optional-opt signature changes). The live-path + altitude passes
found real issues, all fixed here:

- **Live skeleton refresh was a per-event trailing debounce** → starved during a
  burst and could poll forever if a terminal WS event was missed. Replaced with
  an event-driven throttle + terminal-transition refresh (above).
- **Auto-expand latch** could be consumed by a passing fallback group on a
  live-from-empty run, hiding later failures. Restored the `seededNonEmpty` /
  `hasBadGroup` guard.
- **Reconnect** no longer re-hydrated (empty overlay + untouched caches). Added a
  reseed-triggered query invalidation.
- **Row display order** (severity) fought the `(createdAt, id)` cursor → scroll
  jank on paginated groups. Now sorts by `id` desc to match the cursor.
- **Cleanup:** env-tab loader no longer fans out the group-row queries; the two
  route validators share one `GROUP_BY_AXES` / `STATUS_BUCKET_KEYS` source; the
  dead client group engine + its tests removed.

Not fixed (accepted by design, documented in code): during a live run the three
count surfaces (chips / headers / rows) are only eventually-consistent, and a
live row whose group isn't yet in the skeleton appears on the next throttled
refresh (≤`LIVE_STALE_MS`). Worst-first ordering is preserved at the group level
but is now recency (not severity) _within_ a group — a possible follow-up is a
server-side severity cursor.

## Follow-up (2026-07-04): paginate headers, defer the list, skeletons

Three refinements after testing the first cut:

1. **Group headers now paginate** (they were capped at 500 and silently
   truncated beyond that). `loadRunGroupSkeleton` gained a keyset cursor over
   `(severity DESC, key ASC)` — implemented via `HAVING` (the cursor references
   the `failed*4+flaky*2` aggregate, which `WHERE` can't), tiebreak cast to
   `::text` so it's type-safe on the integer `shardIndex` axis. `RunGroupSkeleton`
   now returns `nextCursor` instead of `truncated`; the hard `MAX_RUN_GROUPS` cap
   is gone (replaced by a `DEFAULT_GROUP_PAGE_SIZE = 50` page). The client renders
   the group list as a `useInfiniteQuery` with a bottom `IntersectionObserver`
   sentinel that loads more headers on scroll — so a 1k-file monorepo loads its
   worst-first groups in pages, never truncated. Auto-expand hints are emitted
   only on the first page (later pages, loaded on scroll, never force-expand).
   Within-group row pagination on expand is unchanged (kept as the safety valve
   for a pathologically large single file).

2. **The Tests list loads deferred behind a skeleton.** The loader no longer
   SSR-seeds the skeleton or the auto-expanded group rows — the group list loads
   client-side, showing a `TestsListSkeleton` on first paint, matching the
   deferred-load pattern used elsewhere on the page. The **filter chips stay
   eager** (they read `run.*` via the WS summary — the instant-counts win, and
   the realtime-island seed, must not defer). The loader is correspondingly
   simpler (no group fetches; just run + branches + deferred chart). Note: this
   is a client-query skeleton rather than a Void `defer()` — the tests list is an
   interactive island (filter state in client state, chips eager), so a client
   query is the clean fit; true SSR-streamed `defer()` would require lifting
   filter state to URL params to split the island (a possible follow-up).

3. **Spinners → skeletons.** Filter / group-by / search changes use
   `placeholderData: keepPreviousData` (the current list stays visible, dimmed,
   during the swap — no empty flash); expanding a group and loading more rows
   show skeleton rows instead of a spinner. Fixed a bug found in self-review: the
   auto-expand latch must skip `keepPreviousData` placeholder data, or an axis
   switch would consume the one-shot latch on the prior axis's stale groups and
   the new axis would never auto-expand.

**Verification (follow-up):** `tsgo --noEmit` clean · `pnpm check` 0 errors ·
`pnpm --filter @wrightful/dashboard test` **251 + 1135 passed**, including a new
`pg-integration` test that paginates the group skeleton across 3 pages against
real Postgres (cursor order, `nextCursor` null at the end, and later pages
carrying no auto-expand hints). Dashboard Playwright e2e not re-run here (local
dev-boot is flaky); the `realtime.spec` 0→3 path now relies on the client query +
throttled refresh + live overlay rather than an SSR seed — Playwright's retry
should absorb the extra latency, but worth a CI confirmation.

### "Recommended" filter (default, action-oriented)

Added a **`Recommended`** status chip — the review-worthy tests = the failed ∪
flaky buckets — as the first chip and the **smart default**: the tab opens on
Recommended when `failed + flaky > 0`, else on All (so an all-green run doesn't
land on an empty tab). It's a composite filter, so the single-bucket
`STATUS_BUCKET_MEMBERS[key]` lookup generalized to `statusFilterMembers(value)`
(`recommended` → failed ∪ flaky), single-sourced server-side and mirrored on the
client by `matchesStatusFilter` (live overlay). The route enum `STATUS_BUCKET_KEYS`
became `STATUS_FILTER_VALUES` (adds `recommended`). "Failed first" holds at both
levels: groups already sort worst-first (`failed*4+flaky*2`), and within a group
the Recommended view sorts failed-before-flaky client-side (`recommendedRank`) —
jank-free because a filtered group's rows are few (single page). Empty-state for
a hand-picked Recommended on a green run reads "No failing or flaky tests —
nothing needs review." Tests: pg-integration asserts the composite skeleton +
row filter; `matchesStatusFilter`/`recommendedRank`/`filterTests(recommended)`
are unit-tested. Full suite **1139 passing**, `pnpm check` 0 errors.

## Follow-up (2026-07-05): thermo-nuclear code-quality pass

A strict maintainability review of the diff (abstraction quality, spaghetti
growth, file size, boundary contracts) drove nine behavior-preserving cleanups.
No behavior changed except the recommended-view ordering coherence fix (#3),
which fixes a latent infinite-scroll reorder.

### Structural (the two that mattered)

1. **Decomposed `run-progress.tsx`** (721 → **353** lines) into four cohesive
   modules matching the existing flat `run-*` component convention:
   `run-progress.tsx` (the container: chips + skeleton query + the live-cache
   effects), `run-progress-group.tsx` (`TestGroup` — the per-group row engine),
   `run-progress-row.tsx` (`TestRow` + `GroupStatusCount`), and
   `run-progress-skeletons.tsx` (the three loading skeletons). The 721-line
   grab-bag mixed container orchestration, a second data-fetching engine, and
   presentational leaves in one file.
2. **Extracted the load-bearing algorithms to the tested pure layer.** The
   fetched+live overlay merge/sort (cursor-order-critical) and the skeleton
   page flatten/dedupe were stranded, untested, inside the `.tsx` island. They
   are now `mergeGroupRows` + `dedupeGroups` in `group-tests-by-file.ts`
   (`dedupeGroups` is generic over the header shape, so no server-type import),
   unit-tested next to `filterTests`/`recommendedRank` they already depend on.

### Correctness

3. **Recommended-view page ordering made coherent.** `loadRunResultsPage` now
   orders the `"recommended"` bucket by `(failed-before-flaky rank, createdAt
DESC, id DESC)` via a `CASE` bucket-rank column, with the keyset cursor
   extended to carry that rank (`encodeRankedCursor`/`decodeRankedCursor`,
   `${rank}:${createdAt}:${id}`). Previously the server ordered purely by
   `(createdAt, id)` while the client sorted failed-first, so a group with
   > 200 interleaved failed/flaky rows would pull page 2's older failed rows
   > above page 1's flaky rows on scroll. The client sort is unchanged (it still
   > places live-overlay rows failed-first); only the server page order — and
   > thus cross-page coherence — was fixed. pg-integration paginates a 5-row
   > interleaved group at limit 2 and asserts failed-before-flaky across the
   > boundary with no dupes/skips.

### Branching / boundary / duplication

4. **`skipOwnershipCheck` de-footgunned.** Its docstrings (both opts + the body
   doc) claimed "the SSR loader sets it" — but the loader no longer calls these
   functions (the list is deferred/client-side). Docs rewritten to name the real
   callers; the CSV export loop (`buildRunTestsCsv`), which already probes
   ownership up front, now sets the flag so its N page reads don't each re-probe
   (it was the one legitimate production path leaving it false).
5. **Deleted the redundant file-axis key ternary** in the `/results` route
   (`?? (groupBy === "file" ? "" : null)`) — `groupPredicate` already owns the
   `null → ""` file coercion, so the route now passes `query.groupKey ?? null`.
6. **Auto-expand "bad group" judgement single-sourced to the server.** The
   skeleton page now returns `hasFailingGroup` (the server already computed it);
   the client reads it for the live-from-empty auto-expand guard instead of
   re-deriving `hasBadGroup` over the headers. `isRunning` still comes from the
   WS summary (a fresh DB read would race the terminal transition).
7. **`useInfiniteScrollSentinel` hook** replaces the two copy-pasted
   `IntersectionObserver` load-more effects (group list + group rows).
8. **Search debounce → the existing `useDebouncedValue` hook** (dropped a
   bespoke `useState` + `useEffect`).
9. **Severity weight single-sourced.** `failed*4 + flaky*2` was authored in SQL
   and recomputed in JS for the cursor; now `SEVERITY_FAILED_WEIGHT` /
   `SEVERITY_FLAKY_WEIGHT` + `groupSeverity()` feed both, so the `ORDER BY` /
   `HAVING` key and the cursor recompute can't drift.

**Verification:** `tsgo --noEmit` clean · `pnpm check` **0 errors** (120
pre-existing `packages/e2e` warnings, untouched) · `pnpm --filter
@wrightful/dashboard test` **253 (node) + 1153 (workers) passing**, including new
unit tests for `mergeGroupRows`/`dedupeGroups`, the ranked cursor codec, and a
pg-integration test for the recommended cross-page ordering + `hasFailingGroup`.
Dashboard Playwright e2e not re-run here (local dev-boot is flaky); the Tests-tab
selectors and the realtime 0→N path are unchanged, but worth a CI confirmation.
