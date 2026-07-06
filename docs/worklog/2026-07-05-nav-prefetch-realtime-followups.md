# 2026-07-05 — Nav-prefetch realtime `cacheFor` + lazy-chunk error boundaries

Follow-up to the same-week nav-perf work (`2026-07-04-link-prefetch.md`,
`2026-07-04-nav-speed-followups.md`), from a thorough code-quality review of that
commit (`b2f9697c`). Two real gaps plus two cosmetic/doc fixes. No behavior
change to any loader or query — only prefetch windows, an error-boundary safety
net, one skeleton element, and worklog corrections.

## Why

The nav-perf commit created `PREFETCH_REALTIME="5s"` precisely to stop a
hover-prefetch from committing a **stale realtime seed** (rooms have no replay,
and — verified — `useFeedRoom` only `router.refresh()`es on a WS **re-open after
a drop**, never on initial mount, so a stale committed seed is not self-healing).
It applied the 5s window to the runs-list **row** links but left the other
inbound links to realtime-seeded pages on the 30s default. Separately, the new
`React.lazy` mounts had no error boundary, so a post-deploy chunk-load failure
could throw past `<Suspense>`.

## 1. `PREFETCH_REALTIME` on every inbound link to a realtime-seeded page

Realtime seeds: runs list (`useProjectRoom`), monitors list (`useFeedRoom`), run
detail (`useRunRoom`). Tightened these hover-prefetch links from the 30s default
to `PREFETCH_REALTIME` ("5s"):

| Link                                                            | File                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Sidebar **Runs** (→ runs list) + **Monitors** (→ monitors list) | `src/components/app-layout.tsx` (per-item `cacheFor` on nav)      |
| **"View full report"** popover link (→ run detail)              | `src/components/run-tests-popover.tsx`                            |
| **Breadcrumbs**: "Runs" (→ runs list) + `#run` (→ run detail)   | `page-header.tsx` `Crumb.cacheFor`; set at the 3 run-header sites |

`Crumb` gained an optional `cacheFor` threaded through `HeaderCrumbs`' `<Link>`;
set on the realtime crumbs in `runs/[runId]/index.tsx`, `…/diff.tsx`, and
`…/tests/[testResultId]/index.tsx`. Pagination stays on the 30s default (later
pages rarely carry in-flight runs); the per-test popover links stay on the
default (test-detail is not realtime-seeded).

## 2. Error boundaries around the lazy chunks

`<Suspense>` only catches the _pending_ promise; a rejected `lazy(() => import())`
(hashed-filename 404 after a redeploy while a tab is open, or a transient network
failure) re-throws past it. Reused the existing generic `DeferErrorBoundary`
(`src/components/defer-error-boundary.tsx`) — it renders a `fallback` on any child
error — around both new lazy mounts:

- **CodeMirror** (`ui/code-editor.tsx`): degrades to the always-functional
  `EditorFallback` textarea (which already mirrors the controlled value, so no
  content is lost) instead of blanking the monitor create/edit form.
- **CommandMenu** (`app-layout.tsx`): degrades to `fallback={null}` (⌘K just
  doesn't open) instead of throwing during root-shell render.

## 3. Skeleton `<div>`-in-`<p>` hydration fix

`tests/[testId]/index.tsx` — `HistoryRegionSkeleton`'s "Recent runs" subtitle
wrapped a `<Skeleton>` (a `<div>`) inside a `<p>`, invalid phrasing content that
triggers a React DOM-nesting / hydration warning when the deferred skeleton
streams. Swapped the `<p>` for a `<div className="mt-0.5">`.

## 4. Worklog corrections (`2026-07-04-nav-speed-followups.md`)

- **§2 monitor-detail row** described an intermediate `all({ monitor, … })` shape
  with a `this.$signal` 404-abort the shipped code never had (superseded within
  the same commit by §5). Annotated it as superseded, with the real shape
  (eager serial `monitor` 404 gate; `all({ executions, … })` inside the deferred
  resolver).
- **§4 "left on the 30s default"** note called the sidebar "low-value" — wrong for
  the realtime-seeded destinations. Added a correction pointing here.

## Details

| Item    | Value                                                                 |
| ------- | --------------------------------------------------------------------- |
| New API | `Crumb.cacheFor?: string \| [string, string]` (`page-header.tsx`)     |
| Reused  | `DeferErrorBoundary` (generic error boundary; not just for `defer()`) |
| No deps | no new dependencies; no loader/query/schema changes                   |

## Verification

- `pnpm check` (oxfmt + oxlint + type-aware type-check): **0 errors**, 120
  pre-existing warnings (all in `packages/reporter`/`e2e` — none in touched
  files).
- `pnpm --filter @wrightful/dashboard typecheck` (`void prepare && tsgo --noEmit`):
  **clean** — the new `Crumb.cacheFor` + per-nav-item `cacheFor` types infer fine.
- `pnpm --filter @wrightful/dashboard test`: **244 passed / 4 skipped** (node) +
  **1150 passed** (workers). No regressions.
- Not manually verified in a running app: the actual prefetch `cacheFor` values on
  the wire and the chunk-load-failure degradation — best confirmed with
  `pnpm dev` + devtools/network (throttle + block the chunk).
