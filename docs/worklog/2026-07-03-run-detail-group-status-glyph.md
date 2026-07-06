# 2026-07-03 — Run-detail: group-header status glyph + smaller header summary text

## What changed

Two small run-detail UI refinements.

1. **Group-header status rollup glyph.** In the run-detail Tests tab, each
   collapsible group (file / Playwright project / shard) now shows a
   `StatusGlyph` in its header, mirroring the per-row glyph the child rows
   already show. It reflects the group's **worst** status — `failed → flaky →
passed → skipped` — so a collapsed group communicates "how did this file do"
   at a glance without expanding it.

2. **Header summary text size.** The `SummaryStat` tiles beside the run-detail
   `OutcomeBar` (`RunSummaryLive`) had no explicit font size, so they inherited
   the ~14px base and read oversized next to the 6px bar and the surrounding
   `text-[11.5px]` chips. Dropped to `text-[11px]`, matching the run-list row.

## Details

| File                                                | Change                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/group-tests-by-file.ts`                    | New pure `worstStatusInGroup(counts)` — returns the worst-first bucket present (`failed`/`flaky`/`skipped`/`passed`), or `null` when every bucket is zero (e.g. only in-flight `queued` rows). Reuses the shared severity ordering. |
| `src/components/run-progress.tsx`                   | `TestGroup` derives `worst` via `useMemo` and renders `<StatusGlyph size={13} status={worst} />` after the chevron, before the group name. Renders nothing when `worst` is null.                                                    |
| `src/components/run-summary-live.tsx`               | Summary-stat row: added `text-[11px]`.                                                                                                                                                                                              |
| `src/__tests__/group-tests-by-file.workers.test.ts` | Added a `worstStatusInGroup` describe block (worst-first ordering + null-on-all-zero).                                                                                                                                              |

Design note: the glyph's "worst" order is `failed → flaky → passed → skipped`.
This deliberately ranks `skipped` _below_ `passed` — unlike the app-wide
`statusSortKey`, where skipped outranks passed. A group with even one real
result should read as that result, so `skipped` only wins when the group is
entirely skipped. (Earlier iteration followed `statusSortKey` and showed the
skipped glyph for a mostly-passing group with a single skip, which read wrong.)

## Verification

- `worstStatusInGroup` unit tests pass (workers pool).
- Existing `group-tests-by-file` suite still green.
- `vp check` (format + lint + type) clean on all changed source files.
