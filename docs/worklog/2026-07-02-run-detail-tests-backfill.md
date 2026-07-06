# 2026-07-02 — Run detail: back-paginate tests beyond the SSR seed window

## What changed

On a run with more tests than the loader's `TESTS_LIMIT` (200), the run-detail
Tests tab silently truncated: the header summary (driven by the run's aggregate
columns via `RunSummaryLive`) showed the true counts, while the filter chips and
the grouped list — both derived client-side from `RunProgress`'s `byId`
accumulator — only ever saw the first 200 rows the SSR loader seeded. A
235-test run rendered "199 Passed" in the header but "Passed 169 / All 200" in
the filter bar, and 35 tests weren't browsable at all.

The cursor-paginated `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/results`
endpoint existed for exactly this (its docstring even said "client-side
back-paginator") but nothing called it. This change wires it up: after mount,
`useRunRoom` pages the remainder of the run in and merges it under the live
accumulator, so the list and the per-status chip counts now cover the whole
run. No new endpoint, no schema change.

## Details

| File                                                  | Change                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/realtime/run-progress.ts`         | New pure `mergeBackfilledTests(prev, tests)` — inverse precedence of `applyRunProgressEvent`: rows already in `byId` (seed or live event, both fresher) WIN over back-filled duplicates; referentially stable no-op when nothing is new.                                                                                      |
| `apps/dashboard/src/realtime/use-run-room.ts`         | New `backfill?: { teamSlug, projectSlug, cursor }` option. When `cursor` is non-null, an effect loops the typed `fetch("/api/…/results", { query: { cursor } })` until `nextCursor` is exhausted, folding each page through `mergeBackfilledTests` via the feed-room setter. Abortable (`AbortController`) on unmount/re-key. |
| `apps/dashboard/pages/…/runs/[runId]/index.server.ts` | Loader now returns `testsCursor` (the seed page's `nextCursor`) instead of dropping it.                                                                                                                                                                                                                                       |
| `apps/dashboard/pages/…/runs/[runId]/index.tsx`       | Passes `initialCursor={testsCursor}` to `<RunProgress>`.                                                                                                                                                                                                                                                                      |
| `apps/dashboard/src/components/run-progress.tsx`      | New `initialCursor` prop, forwarded as the `backfill` option (with the slugs it already had).                                                                                                                                                                                                                                 |

## Design notes

- **Merge precedence.** Live WS events use last-writer-wins (`applyRunProgressEvent`);
  back-filled pages use existing-wins. Anything already in `byId` came from the
  SSR seed or a later live event — both at least as fresh as a DB page cut
  before the fetch resolved — so a progress event landing mid-pagination is
  never clobbered by the older page.
- **Reseed interaction.** The reconnect-refresh policy re-runs the loader and
  `useSeededState` rebuilds `byId` from the fresh seed alone, dropping
  previously back-filled rows. The back-fill effect is therefore keyed on the
  `initialTests` seed reference (not just the cursor string, which can be
  identical across refreshes) so each reseed re-fetches the tail.
- **Only the Tests tab back-fills.** `RunSummaryLive` and the other header
  islands read `summary` only; they don't pass `backfill`, so they don't issue
  redundant page fetches.
- **TS7022 workaround.** Inside the paging loop, `cursor`'s narrowing feeds the
  fetch's `query` while being reassigned from its result — TS reports a
  circular-inference error unless the page result is explicitly annotated
  (`const page: RunResultsResponse = …`, type-only import so no server code in
  the client bundle).

## Verification

- `pnpm check` — 0 errors (120 pre-existing warnings, untouched).
- `pnpm --filter @wrightful/dashboard test` (node + workers lanes) — 99 files,
  1129 tests, all passing; includes 3 new `mergeBackfilledTests` cases in
  `src/__tests__/run-progress-reducer.workers.test.ts` (adds unknown rows /
  existing-wins on duplicates / same-reference no-op).
