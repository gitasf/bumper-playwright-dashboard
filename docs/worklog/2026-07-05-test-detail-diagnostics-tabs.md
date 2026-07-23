# 2026-07-05 — Test-detail: captured stdout/stderr in the artifacts rail

## What changed

**Frontend surfacing** for the per-attempt `stdout`/`stderr` capture work (backend:
`2026-07-05-capture-stdout-stderr.md`). On the test-detail page, each attempt's
captured **stdout/stderr** is shown as an **Output** section in the right-hand
**artifacts rail**, alongside that attempt's trace/video/screenshot artifacts.

The assertion **error** continues to render directly in the left column
(`TestErrorAlert` + the "No error details recorded" fallback) — unchanged from
before this work.

> **Design history (two discarded iterations):**
>
> 1. A first cut added a **Trace** sub-tab (a distilled `get_trace_summary`
>    timeline / page-console / network view) + a shared `trace-summary-cache`.
>    That trace-summary feature was removed — it duplicated the error with noise,
>    and the real Playwright trace viewer is already reachable via
>    `get_artifact`'s `traceViewerUrl`.
> 2. A second cut put Error + Output behind a per-attempt **sub-tab group**
>    (`attempt-diagnostics.tsx`). That was also dropped: the tabs were more
>    chrome than the content warranted. Error renders directly again, and Output
>    moved into the artifacts rail. `attempt-diagnostics.tsx` was deleted.

## Details

| File                                                    | Change                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/components/artifacts-rail.tsx`      | `ArtifactsRail` gains optional `stdout`/`stderr` props and an **Output** section (below Artifacts) rendering each stream via a new `RailLogBlock` — scrollable, ANSI-aware (`ansiToHtml`, HTML-escaped first, so test-controlled output is not an injection sink), `stderr` tinted. |
| `apps/dashboard/pages/…/tests/[testResultId]/index.tsx` | Restored direct `TestErrorAlert` rendering in the attempt panel; `resolveAttemptView` still carries `stdout`/`stderr`; an eager `outputByAttempt` map is threaded into `TestArtifactsRail` → `ArtifactsRail`.                                                                       |
| `apps/dashboard/src/components/attempt-diagnostics.tsx` | **deleted** (the sub-tab group).                                                                                                                                                                                                                                                    |

### Notes

- **Output vs error** — the rail's Output is labelled the _test process's_ own
  `stdout`/`stderr` (the test file's `console.log`), distinct from the assertion
  error in the left column, and distinct from the browser page-console.
- **Empty state** — the Output section only renders when a stream is non-empty;
  the rail already no-ops when it has no artifacts / repro / env / output.
- **Defer** — `stdout`/`stderr` are eager (on the attempt row) but ride the rail's
  existing `defer()` boundary, so they appear with the rest of the rail.

## Verification

- `pnpm check` — 0 errors.
- `pnpm --filter @wrightful/dashboard test` — node 248 (+4 skipped) + workers 1184, green.
