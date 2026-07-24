# 2026-07-09 — Design-craft review fixes (apple-design / animations / emil-design-eng)

## What changed

Ran a three-lens design-craft review of the dashboard frontend (Apple fluid-motion, a
brutal animation-code review, and Emil Kowalski's component-polish philosophy) and
implemented the full set of findings. The reviews converged on one systemic gap
(no OS-preference handling) plus a cluster of cheap, high-frequency feel-wins and a
"systematize the craft that already exists" theme.

Nothing here changes behaviour or data flow — the diff is presentational: CSS tokens,
`className` strings, one provider mount, and one new interactive comparison mode.

## Details

### P0 — Accessibility triad (`src/styles.css`)

The app previously had exactly one reduced-motion guard in the whole codebase
(`outcome-bar.tsx`). Added a single global layer covering the vendored `ui/` registry
and app code at once:

| Signal                                 | Behaviour added                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prefers-reduced-motion: reduce`       | Global `*` animation/transition damping (`0.01ms`, iteration-count 1). Functional spinners are exempted and slowed to `1.5s` rather than frozen (a stopped spinner reads as "hung"). |
| `prefers-reduced-transparency: reduce` | `backdrop-filter: none` on all surfaces (modal scrims + sticky table headers stay legible via their opaque-ish backgrounds).                                                         |
| `prefers-contrast: more`               | Promotes the hairline `--line-1` border token to the stronger `--line-2` so borders don't vanish for low-vision users.                                                               |

### P1 — Cheap feel-wins

- **Press feedback.** Added an instant `:active` background tint to `ui/table.tsx` `TableRow` (rows can't cleanly scale; `:active` matches the row while its stretched `RowLink` is pressed — Apple's "respond on pointer-down"). _(An earlier draft of this pass also added `scale-[0.97]` press-shrink to `ui/button.tsx` / `danger-trigger.tsx` / `segmented-control.tsx`; that was dropped per the standing preference against button scale-on-press, so those three files are unchanged and the `:active`-tint above is the only press-feedback change that shipped.)_
- **Tooltip skip-delay activated.** The `data-instant` machinery in `ui/tooltip.tsx` was dead code — `TooltipProvider` was never mounted (only the chart-scoped provider existed). Mounted `<TooltipProvider delay={600} closeDelay={0}>` once at the `app-layout.tsx` root, arming the shared open-delay + instant 2nd-through-nth tooltip for every app tooltip.
- **`transition-all` on width bars.** `ui/progress.tsx`, `ui/meter.tsx`, and `pages/settings/teams/[teamSlug]/usage.tsx` animated bar `width` with unbounded `transition-all duration-500`. Scoped to `transition-[width] duration-300 ease-out-strong`.

### P2 — Systematize (de-drift)

- **Shared easing token.** Added `--ease-out-strong: cubic-bezier(0.22,1,0.36,1)` to `@theme` (generates the `ease-out-strong` utility) so easing has one source of truth. Adopted `ease-out-strong` in the width-bar + command-palette fixes; existing per-component inline curves can migrate over time.
- **Tracking baked into the type ramp.** Added size-specific `--text-{18,22,26}--letter-spacing` companions (`-0.2 / -0.3 / -0.4px`) so a bare `text-18/22/26` now carries the right negative tracking automatically — no per-heading `tracking-[…]` needed. Dropped the now-redundant `tracking-tight` from the settings page title as the reference cleanup.
- **Dead tokens removed.** Deleted the unreferenced infinite `--animate-pulse-soft` / `--animate-progress-stripe` tokens + their `@keyframes` (grep-confirmed zero references).
- **Command palette snap.** The `⌘K` palette (a keyboard, many-times-a-day surface) entered with `ease-in-out duration-200`; changed to `ease-out-strong duration-150` so it snaps rather than easing in.

### P3 — Polish

- **Blur-masked refetch.** The run-progress group-list refetch crossfade (`run-progress.tsx`) now adds `blur-[1px]` alongside the `opacity-60` dim during `isRefetching`, so two co-present datasets read as one reflow rather than a flicker.
- **Toast overshoot tightened.** The success-toast keyframe (`scale 1→1.025→0.99→1`) dropped the sub-1 dip and capped the overshoot at `1.015` — removes the one "playful" bounce in an otherwise crisp system. (The error shake is now gated by the global reduced-motion layer.)
- **Faster spinners.** Overrode Tailwind's default `--animate-spin` to `spin 0.6s linear infinite` (vs the 1s default) in `@theme` so every `animate-spin` call site (`running-spinner.tsx`, `status-glyph.tsx`, `monitors/monitor-status.tsx`, `ui/spinner.tsx`, the loading toast icon) is fast — "faster feels faster" on a live-run dashboard, and there's no way to accidentally ship a slow 1s spinner. (Originally a separate `--animate-spin-fast` token + per-call-site swaps; collapsed to the single theme override in the code-quality review since nothing consumes the framework default.)
- **Dynamic-Type partial adoption.** Body/interactive ramp steps `--text-13` / `--text-14` converted to `rem` (`0.8125rem` / `0.875rem`, == 13/14px at the 16px default → no visual change at default) so the user's browser base-font-size is honoured. Dense chrome (11/12) and headings (18/22/26) stay px for predictable grid density.
- **Visual-diff drag slider.** Added a new "Slider" comparison mode to `visual-diff-dialog.tsx` — expected on the base layer, actual overlaid and clipped via `clip-path: inset()`, with 1:1 pointer tracking + pointer capture + keyboard control (`role="slider"`, arrows / Home / End). This is the one place in the dashboard where direct manipulation earns its keep (comparing pixel diffs is a spatial task). `clip-path` keeps the wipe on the compositor.

### Deliberately left as-is (confirmed correct by the review)

Theme hard-cut on light/dark flip (`theme-toggle.tsx` — an atomic swap beats a 100-element
oklch crossfade); no entrance stagger on server-rendered lists (would fight SSR); the
snap (non-sliding) tab underline (URL/SSR-driven, no measured indicator); no JS animation
library (correct for this product); Geist ships no `opsz` axis so the hand-tuned tracking
is the right substitute for optical sizing.

## Verification

- `pnpm check` — **no lint/type/format issues in any of the 17 changed files** (confirmed none appear in the output; no `TS####` errors). The one reported error is a **pre-existing** `no-unsafe-type-assertion` in `packages/reporter/src/client.ts`, unchanged from `origin/main` (fails on main too; out of scope for this change).
- `vp test run src/__tests__/cn.test.ts` — 3/3 pass (the font-size-token merge logic is unaffected; the px→rem change touches CSS values, not token names or `cn.ts`).
- Changes are presentational; no render/snapshot test exercises the touched components, and the full node-pool suite (`src/e2e.test.ts`) boots a real dashboard requiring a provisioned DB, so it was not run here.
- **Not yet visually verified in a browser** (dev server not run). Recommended manual pass: press feedback on buttons/rows, sidebar tooltip skip-delay, the reduced-motion / reduced-transparency / high-contrast media queries, and the visual-diff slider drag on a real visual-regression run.
