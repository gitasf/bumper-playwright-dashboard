# 2026-07-03 — Run-detail Tests tab: stop the project name leaking into the title + overflowing the row

## What changed

Fixed a layout bug in the run-detail **Tests** tab (`RunProgress` → `TestRow`) where,
in any multi-project Playwright setup, each test row grew taller than it should.

The stored `title` is Playwright's `titlePath` — `project > file > describe… > test`.
`TestRow` only stripped the `${file} > ` prefix _when the title started with the file_,
which is false once a project name leads the chain. So the row rendered:

- the **full** chain (project **and** file path) inside the `>` title, and
- the project **again** in a fixed `w-[60px]` column with no `whitespace-nowrap`/
  `truncate`, so long project names ("Google Chrome for Android", "Mobile Safari")
  wrapped onto a second line and pushed the row past its `min-h-8`.

Now:

- The title is parsed with the existing `parseTitleSegments()` helper (already
  unit-tested, strips both project and file) → the row shows a clean
  `describe > test`. The project/file no longer appear in the `>` chain.
- The trailing indicator is a compact, **non-wrapping** pill (house style, à la
  `EnvPill`) that shows the axis _not_ in the group header:
  - grouped by **file** → the Playwright **project** (capitalized),
  - grouped by **Playwright project** → the **file basename**.
- The pill is omitted entirely for single-project runs (nothing to disambiguate);
  `projectName` is uniform within a run, so alignment holds either way.

## Details

| File                                             | Change                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/components/run-progress.tsx` | Import `parseTitleSegments`; thread `groupBy` into `TestRow`; parse title → clean `describe > test`; render the complementary axis as a `max-w-[128px]` truncating pill instead of a fixed-width wrapping text column. |

No schema, wire-format, or API changes. `parseTitleSegments` was already present and
tested (`group-tests-by-file.workers.test.ts`); this just routes `TestRow` through it.

## Verification

- `vp check` (format + oxlint + type-aware typecheck) — pass on the changed file.
- `void prepare && tsgo --noEmit` (full dashboard typecheck) — pass.
- `vp test run -c vitest.workers.config.ts group-tests-by-file + run-progress-reducer`
  — 44 passed.
- **Manual/visual**: booted the real dashboard (local Postgres + the `tests-dashboard`
  harness), seeded a run with the same test across chromium/firefox/webkit + a long
  "Google Chrome for Android", and screenshotted the Tests tab in both group-by modes.
  Confirmed clean `describe > test` titles, the browser as a truncating pill (long name
  ellipsizes instead of wrapping), single-line rows, and the file-basename pill when
  grouped by project.

## Follow-ups (not done)

- `apps/dashboard/src/components/flaky-test-row.tsx` has the same naive `${file} > `
  stripper (`displayTitle`), so its top line will also leak `project > file > …` in
  multi-project setups. Left alone — different screen, and its row props don't carry
  `projectName` today, so a proper fix needs a small data-shape change.
