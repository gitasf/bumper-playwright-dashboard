# 2026-06-24 — Merge onboarding-docs + e2e-guardrails into embedded-trace-replay

## What changed

Merged `onboarding-docs-and-e2e-guardrails` into `embedded-trace-replay` to pull
the e2e isolation guard (the `run-dashboard-e2e.mjs` wrapper + CI `postgres:16`
service) and the new onboarding documentation onto the trace-replay branch. The
merge was **conflict-free** — the two branches share `65ce1d9` (PR #4) as their
base and touched disjoint files: the trace-replay feature
(`trace-viewer-dialog.tsx`, `vendor-trace-viewer.mjs`, `replay.ts`,
`test-replay.spec.ts`) is untouched by the onboarding branch, so it survives the
merge intact.

Two deliberate follow-up edits on top of the merge:

1. **Dropped the generated HTML docs + the render script.** The onboarding
   branch shipped a `scripts/render-docs.mjs` that rendered a curated Markdown
   set (`CLAUDE.md`, `SELF-HOSTING.md`, `docs/ARCHITECTURE.md`) to `.html`
   siblings, plus a hand-authored `docs/onboarding.html` entry page. We keep the
   Markdown as the single source of truth and **remove the generated HTML + the
   renderer** rather than carry a build step whose only output is checked-in,
   drift-prone HTML.
2. **Test-row chevron fix** (committed just before the merge, `85a57e8`). The
   trace-replay refactor that unwrapped the row `<Link>` to host the replay
   button had turned the hover chevron into a _second_ `<Link>` to the same
   `/tests/<id>` href. Two anchors per row broke the dashboard e2e suite
   (`realtime`, `test-detail`) and added a redundant screen-reader link; reverted
   to the `aria-hidden` `<span>` it is on `main`.

## Details

| Area                 | Change                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge                | `onboarding-docs-and-e2e-guardrails` → `embedded-trace-replay`, `ort` strategy, no conflicts.                                                                                     |
| Removed (HTML)       | `CLAUDE.html`, `SELF-HOSTING.html`, `docs/ARCHITECTURE.html`, `docs/onboarding.html` — generated/entry HTML, not sources.                                                         |
| Removed (script)     | `scripts/render-docs.mjs` (the Markdown→HTML renderer). `scripts/` is now empty and gone. No `package.json`/CI script referenced it, and no doc links to the removed HTML remain. |
| Kept (docs)          | All Markdown sources (`CLAUDE.md`, `SELF-HOSTING.md`, `docs/ARCHITECTURE.md`) and the new `docs/integrations/wrightful-reporter.md`.                                              |
| Kept (e2e guardrail) | `packages/e2e/scripts/run-dashboard-e2e.mjs`, the `test:dashboard` wrapper wiring in `packages/e2e/package.json`, and the `.github/workflows/ci.yml` `postgres:16` service.       |
| Kept (worklog)       | `docs/worklog/2026-06-24-e2e-dashboard-isolation-guard.md` (documents the guardrail half of the merged branch).                                                                   |
| Component fix        | `apps/dashboard/src/components/run-progress.tsx` — chevron back to a decorative `aria-hidden` `<span>`; one navigable link per row.                                               |

## Verification

- **Merge integrity:** trace-replay files (`trace-viewer-dialog.tsx`,
  `vendor-trace-viewer.mjs`, `test-replay.spec.ts`) present; Markdown sources +
  `wrightful-reporter.md` + the e2e wrapper present. ✓
- **No dangling references:** grep for `*.html` / `render-docs` across
  `*.md/json/mjs/ts/yml/jsonc` (excl. `node_modules`) returns nothing. ✓
- **Static checks:** `pnpm check` → 0 errors (120 warnings = pre-existing
  baseline). ✓
- **e2e (pre-merge, on the chevron fix):** the three originally-failing
  dashboard specs (`realtime:118`, `test-detail:5`, `test-detail:44`) pass; full
  dashboard suite 48 passed / 1 skipped (visual baseline, gated). ✓

## Follow-ups (not in this change)

If browser-readable docs are wanted again, prefer a docs site / CI-built artifact
over checked-in HTML siblings.
