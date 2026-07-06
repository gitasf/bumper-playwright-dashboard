# 2026-07-04 — Navigation / page-load speed follow-ups

Follow-ups to the same-day `<Link>` hover-prefetch work
(`2026-07-04-link-prefetch.md`), from a Fable-run audit of remaining
nav/page-load levers. Four changes: re-enable Better Auth cookie cache (a
migration regression), parallelize the hot loaders with `better-all`, lazy-load
CodeMirror off the monitor pages, and tier the prefetch `cacheFor` window by
page type. (The audit's "add a `useNavigation` pending indicator" item was
deliberately skipped for now.)

## 1. Re-enabled Better Auth `session.cookieCache` (regression fix)

`getSession()` runs in `void/auth`'s middleware on **every** authenticated
request (and every hover-prefetch), and without the cookie cache it queries
Postgres each time — one serialized DB phase before any page work.

The cache was enabled pre-migration (worklog `2026-04-30-better-auth-cookie-cache`)
but that config lived in the old rwsdk `packages/dashboard/src/lib/better-auth.ts`
against **ControlDO**; when auth moved to `apps/dashboard/auth.ts`
(`void/auth`'s `defineAuth`) + Postgres, it was not carried over — and void's
`defaults` don't set it. So it had silently been OFF.

- **`apps/dashboard/auth.ts`** — added to the `defineAuth` config:
  ```ts
  session: {
    ...defaults.session,
    cookieCache: { ...defaults.session?.cookieCache, enabled: true, maxAge: 60 },
  },
  ```
  `getSession()` now verifies a signed cookie in-memory and skips the DB within
  the 60s window. `maxAge: 60` bounds both the read-avoidance window and
  cross-device revocation lag (another device keeps a cached session until its
  cookie ages out) — near-zero exposure for a CI dashboard while eliminating
  essentially all per-nav session reads. Tunable; Better Auth refreshes on expiry
  with a real DB read.

## 2. Parallelized the hot loaders with `better-all`

Added **`better-all`** (`^0.0.7`, Shu Ding) — `Promise.all` with automatic
dependency optimization: `all({ async a(){}, async b(){ await this.$.a } })`
runs independent tasks concurrently and sequences dependent ones only where a
task actually `await this.$.<dep>`s another. Its `this.$` hands out **promises**
(it does not proxy resolved values), so there's no interaction with Drizzle's
thenable query builders. Chosen over hand-rolled `Promise.all` because two of
these loaders have real dependency graphs where it wins.

| Loader                                          | Before                                                                                                                       | After                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs/[runId]/index.server.ts`                  | `run` 404-gate awaited **serially** before `Promise.all([tests, branches])`                                                  | one `all({ runRows, resultsPage, branches })` batch — the gate runs alongside the seed + branches (both are independently scope-filtered, so we throw 404 after). −1 round-trip. Tests stay eager (realtime seed — see that file's comment / the prefetch worklog).                                                                                                                                                                                                                                                                    |
| `t/[projectSlug]/index.server.ts` (runs list)   | `Promise.all([count, 3× DISTINCT])` then a **serial** page query gated on the count-derived offset                           | `all({ totalRuns, branchRows, actorRows, envRows, allRuns })` — `allRuns` awaits only `this.$.totalRuns` (for the offset), so it overlaps the slower DISTINCT scans instead of waiting for the whole batch.                                                                                                                                                                                                                                                                                                                            |
| `monitors/[monitorId]/index.server.ts` (detail) | ~5 serialized phases: `getMonitor` → `listExecutions` → `httpUptimeWindows` → `httpResponseTimeBuckets` → `members`/`groups` | **⚠️ superseded within this same commit by §5 below.** This row describes an intermediate `all({ monitor, … })` design with a `this.$signal` 404-abort that the shipped code does NOT have. In the final code `monitor` is an **eager serial 404 gate** (`getMonitor` → throw 404), and the `all({ executions, windows, responseRows, members, groups })` batch moved **inside** the deferred `detail` resolver, fanning out off the already-resolved `monitor` — there is no `monitor` task in the batch and no `this.$signal` abort. |

Behavior is identical to before — same queries, same 404 semantics, same data —
only the scheduling changed. Create-mode (`/monitors/new`) still early-returns
before the detail batch.

## 3. Lazy-load CodeMirror off the monitor pages

`@uiw/react-codemirror` + the JS grammar is ~180 KB gzipped — the biggest chunk
in the app — and it was shipping where it's never rendered.

- **Leaf constant.** `monitors/index.tsx` (the list page) imported
  `DEFAULT_MONITOR_SPEC` from `./monitor-form`, which statically imports the
  editor — dragging CodeMirror onto a page that never edits. Moved the constant
  to the pure `monitors-ui.shared.ts` leaf; `monitor-form.tsx` and
  `monitors/index.tsx` now import it from there. The list page no longer imports
  the form at all.
- **`React.lazy` the editor body.** `code-editor.tsx` statically imported
  CodeMirror but only renders it in the editable, hydrated branch — so the
  monitor **detail** page's `readOnly` "Test definition" view (and the list page)
  paid for CodeMirror they never render. Extracted the CodeMirror JSX to a new
  **`src/components/ui/code-editor-codemirror.tsx`** (default export) and
  `lazy()`-load it inside `code-editor.tsx`, wrapped in `<Suspense>` with the
  existing gutter+textarea as the fallback (also still the SSR / pre-hydration /
  `readOnly` view). Net: CodeMirror loads on demand only when an editable editor
  mounts; `readOnly` editors and the list page never fetch the chunk. Call sites
  (`monitor-form.tsx`, `[monitorId]/index.tsx`) are unchanged — the split is
  internal to `CodeEditor`.

## 4. Tiered prefetch `cacheFor` by page type

Two presets exported from `src/components/ui/link.tsx`, applied at nav links:

- **`PREFETCH_STABLE = ["30s", "5m"]`** (stale-while-revalidate) — non-realtime,
  heavier pages: applied to the **insights tabs** + **range/segment button
  group** (tab-hopping between analytics sub-pages now commits instantly and
  revalidates in the background) and **flaky test rows** (→ test detail).
- **`PREFETCH_REALTIME = "5s"`** — realtime-seeded pages: applied to **run-list
  rows** (→ run detail). Tighter than the 30s global default so a hover-prefetch
  can't commit a badly stale realtime seed; the room + `useRunRoom` backfill
  reconcile the rest.

Left on the 30s global default: sidebar, pagination, and breadcrumbs (mixed or
low-value targets).

> **⚠️ Correction (2026-07-05 follow-up):** this was wrong for the sidebar
> "Runs"/"Monitors" links and the runs/run-detail breadcrumbs + the
> "View full report" popover link — they point at **realtime-seeded** pages
> (runs list → `useProjectRoom`, monitors list → `useFeedRoom`, run detail →
> `useRunRoom`), so the 30s default could commit a stale room seed with no
> initial-mount reconcile. All were moved to `PREFETCH_REALTIME` in the
> `2026-07-05-nav-prefetch-realtime-followups.md` follow-up. Pagination stays on
> the default for now (later pages rarely carry in-flight runs).

## 5. `defer()` on four verified-safe loaders

Streamed the heavy reads behind skeletons so the header / KPI / shell paint
immediately — canonical audit-log pattern: `defer()` + `Cache-Control: private,
no-store` server-side; `<DeferredSection skeleton={…}>` + `use()` client-side.

| Page                            | Eager                                                                                         | Deferred (behind skeleton)                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/[testId]` (test detail)  | all-time aggregate (KPI + existence gate) + a new single-row "latest result" (title/metadata) | recent-runs slice (chart + table, reusing `RunHistoryChartSkeleton`), tag union, quarantine — one `details` group                                    |
| `settings/usage`                | `team` (header)                                                                               | `loadTeamUsage` meter (tier/period/counts/rows); a static subtitle keeps the header eager                                                            |
| `settings/billing`              | `team`, `billingEnabled`, `checkoutSuccess` (off-state + header paint immediately)            | `loadTeamBilling` + derived labels (`billingDetail`); the on-state panel + activating poller stream                                                  |
| `monitors/[monitorId]` (detail) | `monitor` (404 gate + header/config), `httpConfig`/`tcpConfig`, URL flags                     | executions table, uptime tiles, response-time chart, owner alert-recipient picker — one `detail` group (the `all()` batch moved inside the resolver) |

**Correction — `monitors/index` was NOT deferred.** Both earlier audits flagged
the monitors LIST as "safe to defer," but verification showed
`monitors-list.client.tsx` seeds the loader's `monitors` prop into `useFeedRoom`
— it is **realtime-seeded**, exactly like the runs list. Deferring it would drop
live monitor-status events (rooms have no replay) and clobber the seed on reseed,
so it stays eager. (The monitor DETAIL page's `executions` are rendered directly,
not room-seeded, so it defers safely.) All four deferred loaders redirect on
mutation (or have no same-page action), so the deferred-over-mutation-response
caveat doesn't apply.

## 6. Prefetch coverage + `cacheFor` extended

- `cacheFor={PREFETCH_STABLE}` added to the tests-catalog + slowest-tests row
  links (non-realtime test-detail targets), completing the tiering.
- The `<Link>` prefetch wrapper now also covers the monitors + settings nav pages
  (monitors list / index / forms / `[monitorId]`, settings projects / groups /
  general / new / keys) — internal nav goes through `@/components/ui/link` there
  too. (Auth / landing pages stay on the raw `<a>`/`<Link>` — no nav benefit.)

## 7. Lazy-mount the command menu

`app-layout` mounted `<CommandMenu>` (Base UI Combobox machinery, ~15-25 KB gz)
on every page, closed. Extracted the ⌘K shortcut to a light module
(`command-menu-shortcut.ts`) so the layout registers the shortcut WITHOUT
statically importing the heavy menu, then `React.lazy`-loaded `<CommandMenu>` and
mount it only on first open (`cmdMounted` — kept mounted after so its close
animation runs and the chunk isn't re-fetched).

## Details

| Item           | Value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| New dependency | `better-all@^0.0.7` (`apps/dashboard/package.json`)                                       |
| New files      | `src/components/ui/code-editor-codemirror.tsx`, `src/components/command-menu-shortcut.ts` |
| Auth           | `session.cookieCache` re-enabled, `maxAge: 60`                                            |

## Verification

- `pnpm check` (oxfmt + oxlint + type-aware type-check): **0 errors**, 120
  pre-existing warnings — **none in the touched files**. `better-all`'s `this.$`
  dependency types + the `defer()` `Deferred<T>` prop types infer cleanly.
- `pnpm --filter @wrightful/dashboard test:workers`: **1150 passed (100 files)** —
  loader primitives (`page-window`/`resolveOffsetPage`, `run-results-page`,
  `scope-where`), realtime-seed logic (`use-feed-room`, `run-progress-reducer`),
  monitor feed. No regressions.
- `billing-ui.test.tsx`: **9 passed** — the only page-render test touched by the
  defer work. Its mock props were updated to the new deferred `billingDetail`
  shape via a synchronously-_fulfilled_ thenable (React `use()` reads
  `.status`/`.value` inline, so the state→CTA render assertions stay synchronous).
- Not yet manually verified in a running app: the skeleton fidelity / layout
  stability of the four deferred pages, the CodeMirror + CommandMenu chunk-splits
  (that the pages no longer fetch them until needed), and the cookie-cache
  DB-read reduction — best confirmed with `pnpm dev` + devtools/network +
  Cloudflare observability.

## Notes

- `better-all` is now the convention for parallel loader reads where there's a
  dependency graph — prefer `all(...)` over hand-rolled `Promise.all` chains in
  loaders; don't "simplify" it back.
- **Not done, by decision (need runtime testing / heavier changes):**
  - **React Compiler** via `voidReact({ react: { babel: … } })` — the sanctioned
    path exists, but it needs an SSR pass on the heavy pages first (the prior
    "Invalid hook call" incident was the standalone plugin, but this warrants
    verification we can't do headless). Test-gated follow-up.
  - **Per-page `modulepreload`** — would need authoring/extending
    `patches/void@0.10.4.patch` to emit the page's manifest closure; first-load /
    hard-refresh only (SPA navs already prefetch chunks on hover). Deferred as a
    separate, focused task.
