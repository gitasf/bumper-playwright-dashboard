# 2026-07-06 — Merge "performance + optimizations" into main; re-port embedded Test Replay

## What changed

Resolved the conflicts in PR #9 (`joefairburn/wrightful:main` → `gitasf/main`, "performance +
optimizations") by merging the base (`gitasf/main`) into the PR head branch. The two lines had
diverged at `dcf0355`: the base gained the **embedded Test Replay** feature (self-hosted trace
viewer) while the head independently **rewrote the run-detail Tests tab** into a deferred,
server-paginated-by-group architecture. Both changes touched the same three files, so the merge
conflicted:

- `apps/dashboard/pages/.../runs/[runId]/index.server.ts`
- `apps/dashboard/pages/.../runs/[runId]/index.tsx`
- `apps/dashboard/src/components/run-progress.tsx`

The resolution keeps the head's new architecture **and re-ports Test Replay into it** — nothing is
lost. The two features were only superficially in conflict; the real work was that base wired Test
Replay through a mechanism the head had deleted, so the feature had to be re-attached to the new one.

## The architectural collision

- **Head (perf rewrite).** The Tests tab no longer SSR-seeds rows. Filter chips read the live
  `void/ws` summary (`initialSummary`); the grouped list is a server-built skeleton paginated by
  group; each group's rows load lazily on expand via `/api/.../runs/:runId/results`. `TestGroup` /
  `TestRow` were extracted out of `run-progress.tsx` into `run-progress-group.tsx` /
  `run-progress-row.tsx`. The loader now returns `isSharded` + a deferred `chart` instead of `tests`.
- **Base (Test Replay).** Added `trace-viewer-dialog.tsx` (`TestReplayButton`) and computed
  `tracedTestIds` in the run-detail loader from the **SSR-seeded** `tests`, passing it down as a prop
  so each row could light its replay button.

Because the head removed SSR row seeding, base's `tracedTestIds`-from-SSR-tests mechanism had no
rows to derive from. The "has a trace" bit had to move onto the **row-loading path** instead.

## How it was resolved

All three conflict files were taken at the head's architecture (verified byte-identical to the PR
head after resolving). Test Replay was then re-ported:

| File | Change |
| --- | --- |
| `src/realtime/events.ts` | Added optional `hasTrace?: boolean` to the `RunProgressTest` wire type. Not part of the Zod ingest contract and never sent by the reporter — server/UI-derived only, so the contract canary is unaffected. |
| `src/lib/run-results-page.ts` | Added `includeTraceFlags?: boolean` to `LoadRunResultsOpts`. When set, one gated `selectDistinct` over the page's test ids against `artifacts` (type=`trace`, scoped by `projectId`, served by `artifacts_testResultId_idx`) sets `hasTrace` per row. Absent ⇒ `hasTrace` is omitted from the wire. |
| `routes/api/.../runs/[runId]/results.ts` | The run-detail row endpoint passes `includeTraceFlags: true`. The v1 tests API and the CSV export leave it off (they never rendered the button), so they pay nothing. |
| `src/lib/group-tests-by-file.ts` | `mergeGroupRows` now carries `hasTrace` forward when a live `changedTests` event overwrites a server-fetched row (live rows can't carry it — artifacts register after the results flush), so a mid-view live update doesn't drop the button. |
| `src/components/run-progress-row.tsx` | `TestRow` renders `<TestReplayButton>` as a **sibling** of the row `<Link>` (a button can't nest in an anchor) when `test.hasTrace`, with the decorative aria-hidden chevron kept — same DOM shape base used, so the e2e's `xpath=..` row traversal still holds. |
| `src/components/trace-viewer-dialog.tsx` | Doc comment updated: the button's gate is now the row page's `hasTrace` (via `includeTraceFlags`), not the loader's `tracedTestIds`. |
| `tests-dashboard/test-replay.spec.ts` | Stale comment updated to note the failing group auto-expands (so rows — and the button — load without a manual expand). |

### Behavioural notes

- Test Replay buttons appear once a group's rows load. The worst (failing/flaky) group auto-expands
  on first paint, and traces are `retain-on-failure`, so the traced rows are in the auto-expanded
  recommended view — the button shows without a manual expand (matching the e2e expectation).
- A test streamed in live still gets its button only after a reload — unchanged from base, and
  documented on the `hasTrace` field and in `mergeGroupRows`.

## Verification

- `pnpm check` — pass (885 files formatted; 0 lint errors, 120 pre-existing warnings in untouched files; typecheck clean via `tsgo --noEmit`).
- `pnpm --filter @wrightful/dashboard test` — 261 + 1159 passed (node + workers configs).
- `pnpm --filter @wrightful/reporter test` — 281 passed (incl. the schema-contract canary).
- Merge left no conflict markers; the three conflict files verified identical to the PR head branch.

The dashboard Playwright suite (`test:dashboard`, incl. `test-replay.spec.ts`) was not run in this
environment; the port preserves the base DOM structure the specs target, but the suite should be run
before/at merge to confirm end-to-end.
