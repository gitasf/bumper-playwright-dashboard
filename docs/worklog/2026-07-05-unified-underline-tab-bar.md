# 2026-07-05 — Unified all tabs onto one `TabBar`/`TabBarTab` primitive

## What changed

The app had **four different tab implementations**:

- Three hand-rolled copies of the same "flat underline tab bar" — the run-detail
  **Tests / Environment** tabs, the test-detail **attempt** tabs, and the
  **Insights** sub-nav — each re-declaring the same Tailwind (`text-[13px]`,
  `px-3 py-2`, `after:h-0.5 after:bg-[var(--running)]` underline,
  `text-foreground`/`text-muted-foreground` active/inactive). They had already
  drifted subtly (the attempt bar used `after:bottom-0`, the others
  `after:-bottom-px`).
- One Base UI `<Tabs>` wrapper (`src/components/ui/tabs.tsx`) used in exactly one
  place — the **visual-diff modal**. Its `underline` variant painted a dark
  `bg-primary` sliding indicator with taller `text-sm` tabs, so it looked like an
  older, different design from the `var(--running)` flat bars everywhere else.

We consolidated **all four** onto a single shared primitive in
`src/components/ui/tabs.tsx`, using the **run-detail Tests / Environment** style
as the canonical look (per product direction — that's the standard we want to
mostly use). The Base UI `<Tabs>` wrapper had no remaining consumers after the
modal migration, so it was **removed** — there is now exactly one tab component.

### Why a link/button primitive rather than the Base UI `<Tabs>`

The Base UI `<Tabs>` (`Tabs.Root`) owns selection state and renders an animated,
client-measured indicator — built for in-place panel switching inside a client
island. But every tab bar in this app is **URL-driven**: run detail and insights
_navigate_ to a different URL via `<Link>` (Base UI tabs don't navigate at all);
the attempt bar and the visual-diff modal write a search param (`?attempt=`,
`?vmode=`) and their panels live in different parts of the layout, wired only by
the URL, not by a shared `Tabs.Root` context. Forcing these through `Tabs.Root`
would hydrate a client island + measured indicator just to render a few links.
So the standard is a **link/button-based, CSS-underline primitive** — no
selection state, no measured indicator, cheap on server-rendered pages.

## Details

New exports in `src/components/ui/tabs.tsx` (which now contains _only_ these):

| Export                     | Role                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TabBar`                   | Container. `flex items-end gap-1`; draws its own `border-b border-line-1` and lets the active underline overhang it.                                                                                                                                                                                              |
| `TabBar` prop `scrollable` | For narrow columns with many tabs. Switches the container to `overflow-x-auto` and **drops** its own border (a parent wrapper provides it), because `overflow-x` forces `overflow-y` to clip — an overhanging `-bottom-px` underline would be cut off.                                                            |
| `TabBarTab`                | A single tab. Discriminated union: pass `href` (+ optional `cacheFor`) → renders an app `<Link>` (navigates); pass `onSelect` → renders a `<button>` (in-place, typically writes a search param). `active` drives the underline + weight. Extra content (count badges, status dots, suffixes) goes in `children`. |

The scrollable/overhang coupling is carried by a tiny module-local React context
(`TabBarScrollableContext`) so the tab reads the mode the bar declared — call
sites just write `<TabBar scrollable>` and don't touch underline internals.

### Call sites migrated

- `pages/t/[teamSlug]/p/[projectSlug]/runs/[runId]/index.tsx` — Tests /
  Environment bar → `TabBar` + `TabBarTab` (link variant). Live `RunTestCountLive`
  island and the trailing **Compare ↗** link (a plain `<Link>`, not a tab) are
  preserved as `TabBar` children. Sticky `top-[52px]` positioning kept via
  `className`.
- `src/components/attempt-tabs.tsx` — `AttemptTabsBar` → `TabBar scrollable` +
  `TabBarTab` (button variant). Status dot + `finalSuffix` kept as children;
  `useActiveAttempt` (URL `?attempt=`) unchanged; `AttemptPanel` untouched.
- `src/components/analytics/insights-tabs.tsx` — sub-nav → `TabBar` + `TabBarTab`
  (link variant, `cacheFor={PREFETCH_STABLE}`).
- `src/components/visual-diff-dialog.tsx` — `VisualDiffViewer` → `TabBar` +
  `TabBarTab` (button variant, `?vmode=`). Now matches the other bars (accent
  underline + border) instead of the dark Base UI indicator. Panels are rendered
  conditionally on the active mode (only the active one mounts — same as the Base
  UI default and the per-attempt panels), so no `Tabs.Root` state is hydrated.

### Removed

- The Base UI `Tabs` / `TabsList` / `TabsTab` / `TabsPanel` (+ `TabsVariant`,
  `TabsPrimitive`, and the `TabsTrigger` / `TabsContent` aliases) from
  `src/components/ui/tabs.tsx`. No remaining consumers. (Recoverable from git /
  the COSS registry via `npx shadcn@latest add @coss/tabs` if a stateful,
  in-place-panel tab component is ever needed.)

### Intentional minor visual normalizations

The only rendered differences from the pre-refactor copies; all deliberate
consolidations toward the standard:

- **Focus ring:** link tabs (run detail, insights) now get
  `outline-none focus-visible:ring-2 focus-visible:ring-ring` — the attempt tabs
  already had it; now all match instead of some relying on the browser default
  outline.
- **Spacing:** the run-detail count badge dropped its `ml-1.5` in favor of the
  bar's `gap-1.5`; the attempt dot/label gap moved `gap-2 → gap-1.5`. Both ≤2px
  and now consistent across all bars.
- The attempt button's cosmetic `rounded-sm` (no visible effect — the tab has no
  background) was dropped.
- The visual-diff modal tab bar gains a full-width `border-b` rule (the standard
  look) where the old Base UI list had none.

`--border` resolves to `var(--line-1)`, so the attempt bar keeping its parent
wrapper's `border-b border-border` is pixel-identical to the `border-line-1` the
others use.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` (`void prepare && tsgo --noEmit`) — clean.
- `pnpm check` (oxfmt + oxlint + type-aware) — **0 errors**, all files formatted. (The 120 warnings are pre-existing `no-unsafe-type-assertion` in `packages/reporter/src/client.ts` + `src/lib/error-cause.ts`, untouched here.)
- `pnpm --filter @wrightful/dashboard test` — **1413 passed** (260 + 1153), 5 skipped, 0 failures.
- Manual diff review of all five files for behavioral parity (URL-driven selection, live count island, Compare link, status dots, sticky positioning, scroll-safe underline, `?vmode=` panel switching).
