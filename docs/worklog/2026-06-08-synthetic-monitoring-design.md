# 2026-06-08 — Synthetic monitoring: design re-skin

## What changed

Re-skinned the monitors screens (list, detail, create/edit form) to match the
delivered design (a full Wrightful prototype; monitors screens in
`screen-monitors-list.jsx` / `screen-monitors-detail.jsx`), **reusing the
existing `ui/` component library** rather than hand-rolling markup. Visual/UX
only — no data-flow, route, action-name, or create/detail-route-union changes.

The design was authored against the same token vocabulary as our `styles.css`,
so it mapped cleanly to Tailwind utilities + `cn()`.

## Details

| Area                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens (`styles.css`)                   | Added `degraded` / `error` / `queued` / `paused` (+`-soft`) as theme-aware aliases (`degraded→flaky`, `error→fail`, `queued/paused→skipped`) — `var()` refs follow the active theme, no `.dark` edit. Fail-vs-Error stays legible via distinct **glyph + label** (colorblind-safe, matching the existing shape-paired status approach), not hue.                                                                                                                                                                                                                                                |
| Monitor visuals                         | New `src/components/monitors/monitor-status.tsx` — `MonGlyph` (per-state SVG), `MonBadge` (soft pill), `ExecStrip` (recent-execution sparkline), `SummaryPill`, `MON_STATUS`, `monitorDisplayStatus()`. Presentational (no hooks) → server-safe.                                                                                                                                                                                                                                                                                                                                                |
| Loader data                             | `monitors-repo.ts`: `listRecentExecutionsByMonitor(scope, ids, perMonitor)` (bounded concurrent fan-out, ≤ per-project cap) for the per-row `ExecStrip`. `monitors-ui.shared.ts`: pure `uptimeFromExecutions()` (excludes `running` + `error` from the denominator).                                                                                                                                                                                                                                                                                                                            |
| List (`monitors/index.*`)               | Loader enriches each monitor with `recentExecutions` + `uptime`. Page: `PageHeader` (count + "N need attention"), a status **summary strip** (`SummaryPill`s), and a `"use client"` island (`monitors-list.client.tsx`) for the `SegmentedControl` filter + search + the `ui/table` roster (glyph · name + type pill + `MonBadge` · interval · `ExecStrip` · last run · `ui/switch`). Row = stretched-link to detail; the switch (lifted `z-10`) toggles via `fetch` POST to `?toggleEnabled` (`redirect:"manual"` so it stays on the list) with optimistic state. Rich empty-state onboarding. |
| Detail (`monitors/[monitorId]/index.*`) | Loader adds `uptime` + `nextRunAt` + an `?edit=1` editing flag (preserves the create-mode union + all actions). Page: `ui/breadcrumb`, header (glyph + name + `MonBadge` + Pause/Resume + Edit), **meta row** (Type / Interval / State / Last run / **Next run** / **Uptime 24h** color-thresholded), the **execution timeline** (per-state descriptions, duration, "View run" → existing run view), read-only **test definition** (`CodeEditor`), inline edit form (`?edit=1`), danger zone.                                                                                                   |
| Form + editor                           | `monitor-form.tsx` re-laid to the design (2-col name/interval, "Browser check" code section + helper, enabled switch + description, disabled "Run once", cancel/submit) — prop API unchanged. `ui/code-editor.tsx` gained the design's editor chrome (toolbar: `monitor.spec.ts` filename, TypeScript pill, line count, read-only tag; `error` border), keeping the SSR-safe CodeMirror + textarea fallback.                                                                                                                                                                                    |

## Verification

- `pnpm check` (fmt + lint + type): **0 errors** (90 warnings, 2 new benign `no-unsafe-type-assertion` in `monitor-status.tsx`, consistent with the existing 88).
- `tsgo --noEmit`: **0 errors**. Dashboard vitest: **624 passed**.
- Reused existing components throughout (`Table`, `Button`, `Switch`, `Select`, `Input`, `Field`, `Card`, `Breadcrumb`, `Empty`, `SegmentedControl`, `PageHeader`, `time-format`); only the monitor-specific visuals + status tokens are net-new.

### Not verified here (needs the dev server / your env)

- **Visual fidelity** vs the design — view via `pnpm dev` at `/t/<team>/p/<project>/monitors`.
- **E2E** (`monitors.spec.ts`): the re-skin changed list/form markup, so `tests-dashboard/pages/monitors.page.ts` selectors may need a touch-up — re-run `pnpm --filter @wrightful/e2e test:dashboard monitors.spec.ts` and adjust selectors if any drift.
