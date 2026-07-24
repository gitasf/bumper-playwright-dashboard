# 2026-07-06 — Design-system consolidation: one name per token, one component per pattern

## What changed

Follow-up to `2026-07-05-ui-consistency-pass.md`. That pass fixed the visible
drift (segmented controls, search-input sizes, all-caps labels); this one
removes the _sources_ of drift — duplicate token names, copy-pasted class
strings, and bespoke re-implementations of things the component library
already had. Five commits, each independently verifiable.

### 1. Table headers centralized (`ui/table.tsx`)

`TableHead` now carries the canonical header label
(`text-[12px] font-medium tracking-[0.1px] text-fg-3`) in its base class; the
24 per-cell copies across tests/flaky/runs/test-history/slowest-tests/
monitors were deleted. The audit-log and diff tables (which used the bare
14px default) picked up the same style, so every table header in the app now
matches.

### 2. One name per token

`styles.css` defines several aliases (`--muted-foreground: var(--fg-3)`,
`--border: var(--line-1)`, `--foreground: var(--fg-1)`, `--card: var(--bg-1)`)
and app code used both names of each pair at random (130/179, 80/93, 27/92,
17/17 splits). App code (pages/ + src/components/) now uses exactly one name
per token: **`fg-2/3/4` for the gray scale, `foreground` for primary text,
`line-1` for borders/dividers, `card` for the raised surface**. `ui/` registry
files are excluded — they keep the shadcn-idiom names so future
`npx shadcn add @coss/...` scaffolds don't fight the convention.

### 3. One status-chip system (`src/components/status-pill.tsx`)

Previously four chip chromes: `StatusBadge` (ui/badge, `PASSED`), `MonBadge`
(bespoke `rounded-[5px]` soft pill), the run-history hover `StatusChip`
(bordered 12%-tint), and the keys page's inline active/revoked span. All now
render through **`<StatusPill>`** — soft `-soft`-token background,
full-strength token text, optional leading glyph/dot, `rounded-sm`.
`StatusBadge` gained the colorblind-safe `StatusGlyph`; the status registry
swapped `statusBadgeVariant` (now dead) for `statusCssVar`. The invite role
chip became a plain `ui/Badge secondary`; neutral mono meta chips (branch/PR
pills, monitor-type chip) share `META_PILL_CLASSES` (PR pill picked up mono).

### 4. One implementation per interaction pattern

| Pattern               | Shared home                                                                                                           | Former copies                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Underline tabs        | `TabBar`/`TabBarTab` (`ui/tabs.tsx`, absorbed from `audit-run-detail-tabs`; replaced the unused Base UI Tabs wrapper) | run-detail section tabs, attempt tabs, Insights sub-nav, visual-diff modal (4 divergent implementations)       |
| Stretched row link    | `<RowLink>` (`row-link.tsx`)                                                                                          | 6 row components (runs, flaky, tests catalog, test history, slowest tests, monitors)                           |
| Filter-combobox popup | `ComboboxFilterPopup` (`filter-controls.tsx`)                                                                         | `MultiComboboxFilter` + `RunHistoryBranchFilter` (~85% duplicate incl. a byte-identical input class)           |
| Danger-zone trigger   | `DANGER_TRIGGER_CLASSES` (`danger-trigger.tsx`)                                                                       | 4 delete-confirm `<summary>`/button sites; snapped `h-[30px]` → `h-8`                                          |
| Button-lookalikes     | `ui/Button` (+ `render={<Link/>}`)                                                                                    | team-picker Open/Accept/Decline, settings links, diff-page run links, theme toggle, monitor-form remove button |
| Empty states          | `ui/empty`                                                                                                            | monitors onboarding hero was a hand-rolled centered column                                                     |
| Footer without pager  | `TablePaginationFooter` pagination props now optional                                                                 | monitors + flaky passed stub props (`pageHref={() => ""}`)                                                     |
| Display dates         | `lib/time-format.ts` (`formatDateLabel` "6 Jul 25", `formatDateTabular` `yyyy-MM-dd`, `toIsoDate`)                    | inline `dd/MM/yy` + `yyyy-MM-dd` `format()` calls                                                              |

### 4b. Tab bars absorbed from `audit-run-detail-tabs`

The tab consolidation initially shipped here as a class-string helper
(`underlineTabClasses`), but the parallel `audit-run-detail-tabs` branch built
the better version — a `TabBar`/`TabBarTab` primitive in `ui/tabs.tsx`
(link/button discriminated union, scrollable-underline handling), covering the
visual-diff modal too and deleting the unused Base UI Tabs wrapper. Its commit
(`e6f3d24`) was cherry-picked in and the helper deleted. One fix on top: the
old Base UI dialog tabs emitted `role="tab"`/`aria-selected`, which the plain
buttons lost — button-variant `TabBarTab`s now carry real ARIA tab semantics
(with `role="tablist"` on their bars); navigating (`href`) tabs stay plain
links by design. Caught by `test-detail.spec.ts` ("visual diff dialog opens
with all four mode tabs").

### 5. Chrome snaps

- Card radius: `rounded-[8px]` (4 stragglers) → `rounded-[9px]` (the dominant
  22-site radius). Cards are `rounded-[9px] border-line-1 bg-card`.
- Font-size outliers `text-[18px]` → `[17px]`, `text-[14.5px]`/`text-[14px]`
  → `[13.5px]` (monitor detail, diff page).

## Deliberately NOT unified

- **Workspace-switcher rows** — popover menu items with selection state, not
  button clones; forcing `ui/Button` would change a cohesive menu pattern.
- **Table skeletons** — only 2 exist (tests, flaky) with disjoint per-column
  bar shapes that mirror their real tables for CLS-exactness; a generic
  `TableRowSkeleton` would just re-encode per-page specs as props. The truly
  shared skeleton primitives (`TextLineSkeleton`, `KpiCardSkeleton`,
  `TablePaginationFooterSkeleton`) already exist.
- **`MonGlyph` vs `StatusGlyph`** — intentionally distinct colorblind-safe
  vocabularies (monitor states vs test outcomes).
- **Focus rings** needed no change post-refactor: text inputs use
  `ring-[3px] ring-ring/24 border-ring`, everything else `ring-2 ring-ring`
  (the row-ring lives in `RowLink`).

The conventions are recorded in root `CLAUDE.md` under **Design conventions**.

## Verification

- `pnpm check` — 0 errors after every commit (pre-commit hook enforces).
- `pnpm --filter @wrightful/dashboard test` — 1409 tests green (3 new
  date-format cases; status-registry test migrated to `statusCssVar`).
- Full Playwright dashboard e2e suite green against local Postgres 16 +
  Docker (see the 2026-07-05 worklog for the sandbox recipe), plus fresh
  screenshots of runs/tests/flaky/monitors/insights/run-detail reviewed
  manually.
