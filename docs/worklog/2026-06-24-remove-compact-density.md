# 2026-06-24 — Remove the compact/comfortable density toggle

## What changed

Removed the row-density feature (the "Compact density" / "Comfortable density"
toggle in the sidebar user menu) in its entirety. The feature was a near-no-op:
it toggled a `.density-compact` class on `<html>` (FOUC-protected by the boot
script, persisted to localStorage), which overrode four CSS custom properties —
`--row-h`, `--row-h-dense`, `--pad-x`, `--gap`.

In practice the toggle did almost nothing:

- `--row-h`, `--pad-x`, `--gap` were **defined but never consumed anywhere** —
  pure dead tokens.
- `--row-h-dense` had **exactly one consumer**, `run-progress.tsx` (a test row's
  `min-h-[var(--row-h-dense)]`), where compact shrank the min-height from 32px
  to 26px. That single ~6px change on run-progress test rows was the entire
  observable effect of the feature.

So toggling compact density produced one barely-perceptible row-height change
and nothing else, which is why it read as "doesn't do anything."

## Details

| File                                    | Change                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/density.ts`                    | **Deleted** — the density contract module (storage key, class, default, helpers).                                                                                                                                                                                        |
| `src/components/density-toggle.tsx`     | **Deleted** — the `DensityToggle` component.                                                                                                                                                                                                                             |
| `src/__tests__/density.workers.test.ts` | **Deleted** — the density contract test (it asserted the now-removed density branch of `themeInitScript`).                                                                                                                                                               |
| `src/components/sidebar-user-menu.tsx`  | Removed the `DensityToggle` import and its `<DensityToggle variant="menu-row" />` row from the popover.                                                                                                                                                                  |
| `src/lib/theme-init-script.ts`          | Dropped the `@/lib/density` imports and the density `try/catch` branch from the inline boot script; trimmed the doc comment to describe the theme-only behaviour. The CSP discussion (why `script-src 'unsafe-inline'` is load-bearing) is unchanged and still accurate. |
| `src/styles.css`                        | Removed the four density tokens (the now-empty `:root, .dark { … }` block) and the `.density-compact { … }` override block.                                                                                                                                              |
| `src/components/run-progress.tsx`       | Replaced `min-h-[var(--row-h-dense)]` with `min-h-8` (Tailwind `min-h-8` = 2rem = 32px = the prior comfortable/default value), so the default rendered output is identical.                                                                                              |

The theme toggle (`@/lib/theme`, `ThemeToggle`, the `.dark` half of the boot
script) is unaffected — only the density sibling was removed.

## Verification

- `pnpm check` (format + lint + type-check via `vp check`) — **0 errors**, 603
  files. The 120 warnings are pre-existing `no-unsafe-type-assertion` lints in
  `packages/reporter/src/client.ts`, untouched by this change.
- `pnpm --filter @wrightful/dashboard test` — default lane **218 passed / 4
  skipped**, workers lane **1107 passed**. No failures.
- Grep sweep of `apps/**` + `packages/**` for `density-compact`, `row-h-dense`,
  `--row-h`, `--pad-x`, `var(--gap)`, `DensityToggle`, `@/lib/density`,
  `DENSITY_*`, `DEFAULT_COMPACT`, `prefersCompact`, `applyDensity`,
  `isCompactApplied`, `persistDensity` — **no remaining references**.

## Notes

- localStorage may still hold a stale `density` key for existing users; it is
  now simply ignored (nothing reads it), so no migration/cleanup is needed.
