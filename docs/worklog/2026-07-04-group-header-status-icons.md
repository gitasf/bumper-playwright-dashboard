# 2026-07-04 — Group-header status counts: letters → StatusGlyph icons

## What changed

On the run-detail **Tests** tab, each expandable group header (grouped by File /
Playwright project / Shard) shows a per-status count cluster on the right. Those
counts used single-letter suffixes to denote status — `{n}f` (failed), `{n}~`
(flaky), `{n}s` (skipped), `{n}p` (passed).

Switched the letters to the shared shape-per-status **`StatusGlyph`** icon +
count, matching the rest of the site's status language: the worst-status rollup
glyph already on the _same_ header, the per-test-row glyphs, and the run
list/header status glyphs. The icons are colorblind-safe shapes (check / X /
zigzag / three dots), so status is now conveyed by shape **and** colour rather
than a cryptic letter.

## Details

- File: `apps/dashboard/src/components/run-progress.tsx`
- Added a small local `GroupStatusCount` helper (`StatusGlyph size={12}` + count,
  both in the status colour via `statusToken`, wrapped in
  `inline-flex items-center gap-1`), mirroring the existing `SummaryStat`
  dot+count+label shape used in the run-detail header. Also adds a
  `title="{n} {label}"` for a hover tooltip / a11y (replacing the old letter
  hint; the glyph's own `aria-label` names the status).
- Replaced the four letter-suffixed `<span>`s in the `TestGroup` header count
  block with `<GroupStatusCount>`. Order (failed → flaky → skipped → passed) and
  the always-show-passed behaviour are unchanged; the outer
  `gap-2.5 font-mono text-[11px] tabular-nums` container is unchanged.
- Imported `statusLabel` alongside `statusToken` from `@/lib/status`.

No other letter-based status indicators exist on the page — the test rows and the
worst-status header rollup already used `StatusGlyph`; this was the last spot
speaking in letters.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` → exit 0.
- `vp fmt --check` on the file → correctly formatted.
- `vp lint` on the file → exit 0, no findings.
- Manual visual check left to the user (`pnpm dev`, run-detail Tests tab).
