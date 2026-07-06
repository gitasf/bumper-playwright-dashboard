# 2026-07-04 — Deferred-loading/skeleton review fixes (CLS-parity dedup + dead code)

## What changed

Follow-up cleanups on the `deferred-data-loading-skeletons` branch, addressing the
three findings that survived a multi-agent code-quality review of the diff vs
`origin/main`. The review found **no correctness/security/tenant/defer/CLS-live
bugs** — every surviving finding was a reuse/duplication issue in the skeleton
layer, where CLS parity currently relied on manually kept-in-sync duplicated
markup (exactly the drift this branch exists to prevent). All three are
behaviour-preserving.

## Details

| Finding                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **F2** (medium) — the 6-column bottlenecks table header was copy-pasted byte-identically between `BottlenecksSection` (live) and `BottlenecksSkeleton` (fallback) in `slowest-tests.tsx`, the lone insights page not following the branch's own "one shared head" convention | Extracted `BottlenecksTableHead()` and render it from both states — matching the sibling pattern (`FlakyTableHead` / `TestsCatalogHead` / `AuditTableHead`), so the fixed column widths are defined once and can't drift.                                                                                                                                                                                                                              |
| **F3** (low) — the `TablePaginationFooter` loading placeholder was hand-rolled near-identically across four pages (`audit`, `tests`, `flaky`, `slowest-tests`), each a separate box from the real footer's markup and free to diverge (padding/border) → latent CLS          | Added a shared `TablePaginationFooterSkeleton({ showPager?, className? })` to `src/components/skeletons.tsx` that reproduces the footer's box (`border-t px-6 py-3`) once; replaced all four inline `<div>`s with it. `showPager` is passed exactly as each real footer decides it: `totalPages > 1` (audit, slowest-tests), always (tests), never (flaky). `slowest-tests` passes `className="border-border/50"` to match its real footer's override. |
| **F1** (low) — `ListRowsSkeleton` was exported from the new `skeletons.tsx` but had zero import sites monorepo-wide (its would-be consumer, `TestsCatalogSkeleton`, is a `leading-none` table shape the helper can't express)                                                | Removed it. The slot in `skeletons.tsx` now holds the earned-its-place `TablePaginationFooterSkeleton`.                                                                                                                                                                                                                                                                                                                                                |

### Files changed

- `apps/dashboard/src/components/skeletons.tsx` — removed `ListRowsSkeleton`; added `TablePaginationFooterSkeleton`.
- `apps/dashboard/pages/t/[teamSlug]/p/[projectSlug]/insights/slowest-tests.tsx` — added `BottlenecksTableHead`; both header blocks + the footer placeholder now reuse shared components.
- `apps/dashboard/pages/settings/teams/[teamSlug]/audit.tsx`
- `apps/dashboard/pages/t/[teamSlug]/p/[projectSlug]/tests.tsx`
- `apps/dashboard/pages/t/[teamSlug]/p/[projectSlug]/flaky.tsx` — each swaps its inline footer placeholder for `TablePaginationFooterSkeleton`.

## Verification

- `pnpm check` (oxfmt + oxlint + type-aware type-check): **0 errors**, exit 0. The 121 warnings are pre-existing `no-unsafe-type-assertion` in `packages/reporter`, untouched here.
- `grep` confirms: `ListRowsSkeleton` has no remaining references; no hand-rolled footer-placeholder `<div>`s remain in `pages/`; all four `TablePaginationFooterSkeleton` call sites wired with the correct `showPager`/`className`.
- Behaviour-preserving: the shared footer skeleton renders the same box/pager each site rendered before; the extracted header is byte-identical to the two blocks it replaced.
