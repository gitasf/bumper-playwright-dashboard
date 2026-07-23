# 2026-07-05 — UI consistency pass: one segmented-control style, one search-input size, no more all-caps micro-labels

## What changed

A sweep to kill the visual drift between dashboard screens. Three families of
inconsistency, reported against the live site:

1. **Two segmented-control styles.** The monitors page used `SegmentedControl`
   (the design-bundle look: `bg-card` + `border-line-1` container, `bg-bg-3`
   active pill), while tests/flaky/insights used `AnalyticsButtonGroup`
   (`border-border bg-background`, mono font, `capitalize`, `bg-muted` active).
   `AnalyticsButtonGroup` now renders through shared class helpers exported
   from `segmented-control.tsx` (`SEGMENTED_GROUP_CLASSES` /
   `segmentedItemClasses`), so the two components are pixel-identical — the
   only remaining difference is semantics (links vs buttons), which is the
   point of having both.

2. **Search inputs with three different sizes.** Runs list was `h-8`/240px,
   tests catalog was `h-7`/`max-w-[360px] flex-1`, monitors was `h-7`/220px,
   run-detail test filter was `h-7`/260px. `searchFilterInputClassName` now
   bakes in the toolbar standard (`h-8`, `text-[13px]`, `placeholder/72`,
   webkit-cancel-button reset — previously per-caller overrides), and every
   caller uses `w-[240px]`. Segmented controls also moved to a fixed `h-8`
   (they were ~30px), so every control in a `PageToolbar`/`RunsFilterBar` row
   is now the same height.

3. **AI-looking all-caps micro-labels.** ~40 call sites used variants of
   `text-[10–11.5px] font-semibold uppercase tracking-[…]` (table headers, KPI
   labels, the artifacts-rail `REPRODUCTION`/`ENVIRONMENT` headings, monitor
   detail meta labels, settings eyebrows, mono-uppercase link-buttons on the
   picker/invite/settings pages, `StatusBadge`'s `.toUpperCase()`). All now use
   the design-bundle label style already established by `AnalyticsKpiCard`:
   **`text-[12px] font-medium tracking-[0.1px] text-fg-3`** — normal case, no
   mono, no letterspacing games. (`muted-foreground` aliases `fg-3` in
   `styles.css`, so the color unification is a no-op at runtime.)

## Details

| Area                                                    | Change                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/segmented-control.tsx`                  | Exports `SEGMENTED_GROUP_CLASSES` + `segmentedItemClasses(active, compact)`; container is `h-8 items-stretch` (was padding-derived ~30px)                                                                 |
| `src/components/analytics/button-group.tsx`             | Re-styled via the shared segmented helpers; dropped `font-mono`/`capitalize`/bespoke chrome                                                                                                               |
| `src/components/search-filter-input.tsx`                | Default is now `h-8 text-[13px]`, muted placeholder, no webkit cancel button; callers no longer override sizing                                                                                           |
| `src/components/run-history-branch-filter.tsx`          | New `variant` prop: `toolbar` (default) renders the standard h-8 `FilterTriggerButton` (same as the runs page facets, with clear-X); `inline` keeps the small mono pill for the run-detail chart subtitle |
| `src/components/status-badge.tsx`                       | `PASSED` → `Passed` via `statusLabel()`                                                                                                                                                                   |
| `src/components/kpi-inline.tsx`                         | Label uses the canonical 12px style (was 10.5px uppercase)                                                                                                                                                |
| `src/components/artifacts-rail.tsx`                     | `SectionLabel` (Artifacts/Reproduction/Environment) + Terminal chip de-uppercased                                                                                                                         |
| Table headers                                           | tests catalog, flaky, runs list, test history, slowest-tests, monitors roster all use the canonical label style (was 10.5px uppercase semibold)                                                           |
| Monitor detail / alert fields / visual-diff / diff page | Section + meta labels moved to the canonical style                                                                                                                                                        |
| Picker/invite/login/settings pages                      | Mono-uppercase link-buttons, field labels, and role/key-status chips de-uppercased (chips use `capitalize` so lowercase enum values render as `Active`/`Owner`)                                           |
| `pages/t/…/tests.tsx`                                   | Search form fixed at `w-[240px]`, placeholder shortened to "Search tests…"; removed redundant `capitalize` pass-through                                                                                   |

No schema, API, or dependency changes. Pure presentation, plus the
`RunHistoryBranchFilter` variant prop (all seven toolbar/header call sites get
`toolbar` by default; the run-detail chart subtitle opts into `inline`).

**Follow-up fix (same day):** the faceted filter triggers (Status / branches /
authors / envs / date range) were still 28px next to the 32px input. Cause:
the Button `sm` size is responsive — `h-8 … sm:h-7` — so the bare `h-8` in
`FILTER_TRIGGER_CLASSES` lost to the `sm:`-scoped rule at desktop widths.
Added `sm:h-8` to `FILTER_TRIGGER_CLASSES`, then verified in a real browser
(Playwright `offsetHeight` on the runs toolbar): search input, all five
triggers, and the segmented group each measure exactly 32px.

## Verification

- `pnpm check` — 0 errors (requires `void prepare` on a fresh clone; the
  remaining warnings are pre-existing in `packages/e2e` / `packages/reporter`).
- `pnpm --filter @wrightful/dashboard test` — 1153 + 253 passed.
- Full Playwright dashboard suite (`pnpm --filter @wrightful/e2e
test:dashboard`) against a local Postgres 16 (`initdb` + `pg_trgm` from
  postgresql16-contrib; `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/…`)
  — see final result in the PR/commit; the suite exercises the runs list,
  tests catalog, monitors roster, and detail pages end-to-end.
- Grepped: zero `uppercase` utility usages left under `apps/dashboard/pages`
  and `src/components` (excluding the CodeMirror editor internals).
