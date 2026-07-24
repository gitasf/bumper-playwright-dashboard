# 2026-07-11–12 — `review` branch consolidated (deepening + hardening + DB review + perf + e2e)

Consolidates every same-branch worklog into one entry: an architecture
deepening pass, its code-quality review fixes, a HIGH-severity GitHub-App
security fix, the pg-integration test split, a DB security/performance
review, a frontend/loader performance pass (with the test-detail defer split),
a Playwright best-practices pass over the e2e suite, and a "you might not need
an effect" cleanup. All landed uncommitted on the `review` branch, sharing one
working tree; commit strategy was deferred to a human so the strands aren't
entangled.

None of the locked ADR decisions (realtime rooms, capability-flagged billing,
direct-R2 seam, DELETE retention / epoch-seconds) were re-litigated.

---

## 1. Architecture deepening pass (9 shallow→deep refactors)

`/improve-codebase-architecture` surfaced nine deepening opportunities (shallow
modules, drifted duplicates, misplaced test surfaces). Each was implemented by an
isolated agent and independently re-verified. All behavior-preserving except C2
(a real bug fix) and C9.2 (a cursor-validation drift fix).

- **C1 — `appendRunResults` real-DB test surface.** The highest-blast-radius ingest
  entry point was tested only against a mock db; the real-SQL lane bypassed it via a
  hand-rolled lock-less `flush()` copy. Replaced that copy with a direct
  `appendRunResults` call (pglite + real node-postgres), added end-to-end + zero-delta
  serial re-flush tests, and un-exported the now-internal helpers. `src/lib/ingest.ts`,
  `src/__tests__/pg-integration/` (later).
- **C2 — one settled-result→monitor-badge projection (bug fix).** The badge rule was
  implemented twice and drifted: persist skipped the bump on `infraError`, broadcast set
  it unconditionally — so a browser Monitor hitting sandbox capacity flapped its live
  badge red for every subscriber while the DB recorded nothing. Extracted
  `monitorBadgeUpdate(result, settledAt) => {lastStatus, lastRunAt} | null`; both paths
  derive from it. `monitors/executor.ts`, `monitors-repo.ts`, `realtime/events.ts`.
- **C3 — one `serveArtifactBytes` owns proxy-vs-302.** The three origin-safety invariants
  (content-type sanitisation, forced attachment, remaining-life cap) were re-asserted
  inline on the ADR-0003 direct-R2 302 branch. New `src/lib/artifacts/serve.ts` applies
  all three on whichever branch it takes (302 via injected presigner); the download route
  shrank to verify-token → CORS → serve.
- **C4 — membership `role` carried on the by-slug scope.** `makeTenantScope` dropped
  `role`, forking the session-API resolvers into near-clones. New
  `tenantContextForUserBySlugs` returns `{project (with role), scope}`; collapsed the two
  clones into `resolveProjectApiScope`. Brand-launder discipline intact.
  _(Superseded by §2.2 — capability param is now required, not optional/fail-open.)_
- **C5 — action DB-failures routed through `describeError`.** Action mutation-failures
  logged `{message, stack}` only, dropping the pg SQLSTATE from Tail. New
  `logMutationFailure(context, err, extra?)` in `action-errors.ts`; retention/deleteTeam/
  codeowners/deleteProject catch sites route through it.
- **C6 — canonical `loadRun`/`RUN_SUMMARY_COLUMNS` read-model.** The run-summary column
  set was re-spelled in four read surfaces and had drifted (MCP silently omitted
  `expectedTotalTests`). New `src/lib/run-read-model.ts` exports the shared 18-column base
  - generic `loadRunColumns`; each surface spreads base + documented extras.
- **C7 — deep `paginateOffsetTable`.** Offset pagination's fetch orchestration was
  hand-reassembled in four loaders. Deepened `page-window.ts` with an offset mirror of
  `paginateRunTests` (folds in canonical `parsePage`); three loaders fully adopt, runs-list
  stays a partial adopter. _(Polished in §2.4 — `mapRows` optional,
  `shouldRefetchClampedPage` private.)_
- **C8 — typed per-page form-flash seam.** No-JS form errors travelled as stringly-typed
  `?slotError=` spelled 3–4× with no compiler link (`githubError` was the smoking gun —
  written cross-file, a typo silently drops the banner). New `src/lib/flash.ts`
  `defineFlashSlots([...] as const)` → typed `fail`/`read`; a typo is now `TS2345`. Wire
  keys byte-identical.
- **C9 — six low-effort consolidations.** (1) `github-app.ts` split → env-free
  `github-http.ts` core; (2) one keyset-cursor codec (`keyset-cursor.ts`) — fixed the
  `sep < 0` vs `<= 0` drift that accepted an empty leading segment; (3) `csvExportResponse`
  helper; (4) `config-auth-parity.test.ts` locking `auth.ts`'s config-time flag rules
  against `config.ts` (can't share a module — a `void prepare` constraint); (5)
  `monitorFamily(type)` helper; (6) `createProjectAudited` pairing create + audit.

## 2. Code-quality review fixes on the deepening/hardening pass

A strict review of the combined working tree confirmed a genuine complexity-deleting
consolidation and flagged two structural findings + smaller ones.

1. **GitHub check-run claim: dedicated `githubCheckClaimedAt` column** replaces the
   negative-epoch sentinel packed into `githubCheckRunId`. The sign-encoding had radiated
   sentinel-awareness (every reader went through `realCheckRunId()`, a duplicate inline SQL
   `CASE`). New nullable `runs.githubCheckClaimedAt` (epoch seconds) carries the claim;
   `githubCheckRunId` is now always a real id or null. Excluded from `RUN_PUBLIC_COLUMNS`
   (server-side coordination state). Migration `20260711160102_right_sentinel.sql` (additive).
2. **Auth gates: capability parameter now REQUIRED (`CapabilityGate`).** C4 left an omitted
   capability meaning bare-membership (fail-open — a copied read call site silently grants
   viewers write). New `CapabilityGate = Capability | "anyMember"`; both seams require it, so
   omission is a type error. `capability-gate.workers.test.ts` drives both through real Hono apps.
3. **One home for the membership row shape** — `UserProjectMembership` declared once in
   `authz.ts`; `scope.ts` type-imports it (its lazy-import cycle-avoidance unaffected).
4. **`page-window.ts` polish** — `shouldRefetchClampedPage` module-private; `mapRows` optional
   via two overloads with no cast (the `Omit` form broke contextual typing at adopters).
5. **Test/doc hygiene** — merged a duplicated `error-cause.test.ts` into `src/__tests__/`;
   fixed a stale `formatDuration` cross-reference comment in the reporter.

## 3. H1 — verify GitHub App installation ownership in the setup callback

Closed a HIGH-severity confused-deputy / installation-takeover hole in
`GET /api/github/setup`. The callback linked a GitHub App installation to a Wrightful
team on the strength of two **attacker-suppliable** query params (`state` = team slug,
`installation_id` = enumerable integer) plus an owner gate on the _team_ — but never
checked the caller's relationship to the _installation_. Since Wrightful holds the App
private key it can mint a token for any installation, so a signed-in owner of a throwaway
team could claim any **unlinked** installation and drive that org's repos via merge-gating
check runs (locking out the real owner, since `accountLogin` is globally unique).

**Fix:** before persisting, call GitHub `GET /user/installations` with the signed-in
user's **own** stored OAuth token and require `installation_id` to appear (GitHub's own
answer to "which installations may this user manage"). New
`verifyUserAdministersInstallation` + pure `userInstallationsInclude` in `github-app.ts`;
new `getUserGithubAccessToken` reads the `github` provider's `accessToken` from the
void-owned `account` table. Verdict is leak-safe and never throws — `authorized` /
`denied` / `error` (+ a "connect GitHub first" flash for no-token), all mapped to the
existing `githubError` slot, no 500s. All prior defenses untouched. 9 new unit tests.

**Residual risk (for a human):** the sign-in OAuth client should be the **GitHub App's
own** client credentials — if a deployment signs in via a _separate_ GitHub OAuth App the
endpoint won't list the App's installations and legit owners are refused (fails **closed**,
safe, but a self-hosting usability trap). Email+password owners who never linked GitHub now
get "connect GitHub first" (intentional). GitHub lists installs to `:read`/`:write`/`:admin`
users, so a repo collaborator could pass — still a far higher bar than integer enumeration,
and it's GitHub's own manage-installation signal.

## 4. Split `pg-integration.test.ts` into a domain directory

Pure decomposition of the 2,781-line file — no test deleted or changed, **69 → 69** `it(`
cases. Now `src/__tests__/pg-integration/`: `harness.ts` (shared boot — not a suite),
`ingest.test.ts`, `pagination.test.ts`, `analytics-numeric.test.ts`, `members-billing.test.ts`,
`jsonb-roundtrip.test.ts`. Growth (~2,994 lines) is per-file hoisted-mock boilerplate —
`vi.mock("void/db", …)` is a per-file interception that can't be shared; the
`vi.hoisted(async () => await import("./harness"))` dance builds the Drizzle instance before
downstream imports resolve `void/db`. Table DDL is now file-scoped (each file resets only the
tables it touches via `resetTables`).

**Real-Postgres isolation:** all files share ONE `PG_TEST_URL` database and each `beforeAll`
does `drop table … cascade` against shared tables, so parallel runs race (verified: 7 flaky
failures). CI runs the directory with **`--no-file-parallelism`** (69/69, repeatable) rather
than per-file schemas — this leg is the slow/thorough authority, not a parallelism benchmark.
The pglite lane gets a fresh in-process instance per file, so it's isolated regardless. CI
invocation, `CLAUDE.md`, `CONTRIBUTING.md`, and comment cross-refs updated; historical docs
left as point-in-time.

## 5. DB review — security hardening + query-performance fixes

A full DB-query review found **no SQL-injection paths and no tenant-isolation breaks** (the
branded-`TenantScope` family, `escapeLike`/`likeEscaped`, and `assertSqlIdentifier` held
everywhere). It surfaced two defense-in-depth gaps and five perf items.

**Security (convention parity, no live vulns):**

1. `github-checks.ts` was the one module writing `runs` with an id-only WHERE — every
   predicate now ANDs `eq(runs.projectId, …)` (matching `runByIdWhere`); `claimCheckRunSlot`
   / `maybePostGithubCheck` gained a `projectId` param. Regression: a mismatched `projectId`
   no-ops.
2. One test-result loader used plain-string `project.id`; now uses branded `scope.projectId`.

**Performance:** 3. **`reconcileUsage` rewritten set-based** — was a per-team loop with an unindexed
`teamId = ? AND createdAt >= ?` runs count (daily seq scan of the largest table per team).
Now two `teams LEFT JOIN …` GROUP BY queries + one bulk `onConflictDoUpdate` (LEFT JOIN
preserves rebase-to-zero for idle teams). 4. **New index `runs_team_createdAt_idx (teamId, createdAt)`** backing the rollup
(migration `20260711220029_careless_sentinel.sql`). 5. **Trigram GINs on `runs` (`commitMessage`, `commitSha`, `branch`)** — same migration —
backing the runs-list `%q%` ILIKE search; write amplification on run OPEN only, not the
`/results` hot path. 6. **Runs list: OFFSET → keyset pagination** — reuses the export/public-API keyset machinery
(`(createdAt, id)` DESC, page-size+1 for `hasMore`); opaque `?cursor=` + `?history=`
ancestor stack. **UX: numbered strip → Previous/Next** (other tables keep numbered mode);
footer renders a derived static "Page X of Y" orientation label. `page` removed from
`RunsFilters` (`parsePage` kept for offset pages). 7. **Per-test detail KPIs deferred** — the all-history `percentile_cont` aggregate moved to
its own `defer()`; the 404 gate rides the eager latest-row point-seek. 8. **Monitors list fan-out → one query** — `row_number() OVER (PARTITION BY "monitorId" …)`

- `rn <= perMonitor`, scoped by `projectId` + bound `monitorId` IN-list. Epoch columns
  `cast(… as double precision)` (int8-as-string trap; avoids the int4 2038 overflow).

9. **Usage page testResults count deferred** — month-window `count(*)` is now a
   `defer()`-streamed meter; counter-backed meters render immediately.

_Explicitly not changed:_ ingest hot path, cron sweeps, retention drain (reviewed clean); the
eager runs-list `count(*)` + DISTINCT filter-option scans (still needed for count text +
dropdowns).

## 6. Performance pass — SSR loaders + React frontend

Implemented every SSR-loader and frontend finding from the 2026-07-12 performance review
(the DB-query layer is §5; API/ingest findings — reporter flush cadence, `bumpTeamActivity`
debounce, parallel broadcasts — were deliberately left out of scope).

**Loaders** (each standalone Drizzle chain is a fresh Hyperdrive `pg.Pool` connection under
the void patch, so round-trip count dominates loader latency): collapse serial awaits of
independent queries into one `better-all` wave, stop re-querying data the tenant middleware
already resolved, and stop shipping columns the page never renders.

- `runs/[runId]/index.server.ts` — run row ∥ `loadProjectBranches` (2 serial → 1 wave).
- `insights/run-duration.server.ts` — the two percentile CTEs run `Promise.all` inside the
  deferred resolver.
- `runs/[runId]/diff.server.ts` + `run-diff.ts` — `resolveRunDiffTargets` restructured to two
  waves; new optional `baseCandidateLimit`/`baseCandidates` + `loadBaseCandidates` keeps
  base-selection branching in one place (3 serial → 2 waves; JSON API path pays nothing).
- `…/p/[projectSlug]/keys.server.ts` — keys list ∥ codeowners row.
- `settings/…/general.server.ts` — project count ∥ retention ∥ GitHub installs; count is now
  `count(*)` via `numericSql` (int8-as-string trap) instead of fetching every id for `.length`.
- `t/[teamSlug]/index.server.ts` + `pages/index.server.ts` — team/user-teams read from the
  middleware `shared` bundle; zero-project teams short-circuit (2 → 0 round trips for empty
  teams). The `asc(projects.id)` first-project pick stays (bundle has no `id`).
- `flaky.server.ts` + `flaky-test-row.tsx` — dropped never-rendered `errorStack` from the
  recent-failures CTE, cut `RECENT_FAILURES` 3 → 1 (150 multi-KB rows → 50 slim).
- Settings-wide (`middleware/01.context.ts` + `authz.ts` + `settings-scope.ts`) — the bundle
  query already fetched every membership+role and discarded all but the cookie team; now
  retained as **server-only** `memberTeams` context var (not on the client `SharedBundle`);
  `requireRoleScope`/`resolveOwnedTeam` consult it before the `resolveTeamBySlug` fallback
  (−1 membership query on ~10 settings pages; API/STUB paths hit the unchanged fallback).

**Frontend** — the ws plumbing (shared sockets, reducer bailouts) was already good but nothing
was memoized and the reducers churned `summary`/group-array identities every event, so a
streaming run re-rendered the whole Tests tab and all 20 runs-list rows on every broadcast.

- `realtime/run-progress.ts` — `applyRunProgressEvent` reuses `prev.summary` on shallow-equal
  (typed field-by-field compare — a new wire field is a compile error until compared) and
  returns `prev` outright for empty-`changedTests` + equal-summary events. New lean
  `applyRunSummaryEvent` reducer that ignores `changedTests` (no `byId` clone).
- `realtime/use-run-summary.ts` (new) — summary-only counterpart of `useRunRoom` over the same
  `useFeedRoom` machinery; the four summary-only leaves switched to it (removes 4× full-map
  clones per event near the end of a 5k-test run). Only `RunProgress` still folds `byId`.
- `run-progress.tsx` — `liveByGroup` identity-stable via a per-id-diffed snapshot cache; only
  touched groups' arrays rebuild. `onToggle` passes a stable `useCallback`d `toggle(id)`.
- `run-progress-group.tsx` / `run-progress-row.tsx` — `TestGroup`/`TestRow` `React.memo`d
  (prop-identity documented per file): ~1 group + changed rows re-render, not every group+row.
- `run-list-row.tsx` — `RunListRow` memoized (20 → 1 per event); hover prefetch disabled on
  the stretched `RowLink` (sweeping the table had fired up to 20 run-detail loaders every 5 s).
- `live-duration.tsx` — per-row `setInterval` → one shared module-level 1 s ticker via
  `useSyncExternalStore`; pauses on hidden tab, torn down when the last running row unsubs.

### 6.1 Test-detail: defer heavy per-attempt fields

The test-result detail page eagerly shipped every attempt's `errorStack` (~128 KiB), `stdout`
(64 KiB) and `stderr` (64 KiB) — a 3-retry flaky test added several hundred KB of SSR/hydration
payload, most for attempts the viewer isn't looking at. Split per-attempt reads into eager
(`attemptSummaries` + `primaryAttempt` error — above-the-fold, no Suspense) and one deferred
`attemptDetails` (all-attempts heavy fields), consumed via `use()` from both the non-primary
attempt panels (each behind a `DeferredSection`, mounted on tab click) and the artifacts rail's
Output section. `loadTestResultChildren` was split into composable helpers
(`test-result-children.ts`) so the MCP `get_test_result` surface keeps its identical eager
`{tags, annotations, attempts}` shape. Both page mutations (quarantine/owner) are separate API
routes + redirect (fresh GET), so the "no deferred props over a mutation response" caveat
doesn't apply. Worst-case eager payload ~832 KiB → ~192 KiB.

## 7. Playwright best-practices pass over the e2e suite

Ten findings from a `packages/e2e` review against Playwright best practices (resilient
locators, web-first assertions, fixtures over shared state, no hard sleeps / `networkidle`,
minimal CLI reporters); all ten applied, **no test semantics changed**.

- `realtime.spec.ts` fixed `waitForTimeout(800)` → `gotoAndAwaitRoom` collects `websocket`
  events (first connect + a bounded 2 s wait for the dev-mode remount reconnect), no sleep.
- `login.page.ts` dropped `networkidle` → waits for the `X-VoidPages: true` post-hydration
  re-nav (matched on pathname, 5 s bounded fallback); `auth.spec.ts` routes its two `?next`
  settles through `gotoSignIn(query?)` so settle logic lives in one place.
- `test-replay.spec.ts` XPath parent-hop → `div.group` filtered by `has:` Replay button + link.
- Styling-class locators (`div.mb-4`, all-divs+`.last()`, `div.sticky.top-0`) → `data-testid`
  (`group-card`/`key-row`/`run-header`) threaded through `SettingsCard`/`DetailHeaderBar`.
- `cross-tenant.spec.ts` `beforeAll` + module `let` + per-test guards → worker-scoped
  `secondTenant` fixture seeding user/team/project/key/run B once per worker.
- Demo + load configs got the `CI || CLAUDE → line` reporter guard (matters for the 1000-test
  load config).
- `groups.spec.ts` deleted success-path-only cleanup (timestamped name + DB reset made it a
  no-op that could mask failures); the 8-way duplicated runs-list → run-detail preamble → new
  test-scoped `openSeededRun(branch?)` fixture; `logout.spec.ts` opaque 3-way boolean → named
  cookie/condition; dead unscoped `getByRole("switch")` removed.

App-source impact is confined to test hooks: two components gained an optional `data-testid`
pass-through prop, three call sites set one; no behavior change.

## 8. Remove unnecessary `useEffect`s ("You Might Not Need an Effect" pass)

Audited all 26 `useEffect` sites (all in `apps/dashboard`); fixed the seven matching an
anti-pattern, left every legitimate external-system sync (WS rooms, DOM listeners, timers,
IntersectionObserver, TanStack invalidation, hydration reads) alone.

- `monitor-edit-dialog.tsx`, `command-menu.tsx`, `reveal-once-dialog.tsx` — prop→state
  re-sync effects → compare-during-render (`prevOpen`/`open`-transition), server flip visible
  same frame; reveal-once caches `children` during render while open (was committing a `null`
  first frame).
- `app-layout.tsx` — `cmdMounted` latch → render-time one-way latch.
- `runs-filter-bar.tsx` (`RunsSearchInput`) — `useDebouncedValue` + two `exhaustive-deps`-
  suppressed effects → debounced `setTimeout` scheduled in `onChange` (reads latest
  pathname/filters via ref) + a during-render back-sync gated on "not mid-debounce"; both
  lint suppressions gone.
- `trace-viewer-dialog.tsx` (`ReplayModalHost`) — hand-rolled fetch-in-effect → TanStack
  `useQuery` keyed on the replay id, `staleTime: Infinity` (traces immutable → reopen hits
  cache); the no-trace `setReplay("")` fallback stays a small effect (nav can't run in render).
- `{login,signup,reset-password,forgot-password}.tsx` — four identical hydration-gate effects
  → shared `src/lib/hooks/use-hydrated.ts` (`useSyncExternalStore`, flip lands in the hydration
  commit, no extra re-render). Gate purpose unchanged: submit disabled pre-hydration so a
  native submit can't GET the page with credentials in the query string.

---

## Verification (final combined state)

- **`pnpm check`** → exit 0 (format + lint + type-check; 0 errors, ~139 pre-existing
  warnings, none in changed files).
- **Dashboard tests** → green: node/pglite lane 315 passed / 4 skipped; workers lane 1302
  passed; reporter 295 passed. (A known parallel-run flake in the source-scanning guard tests
  `aggregate-coercion-guard` / `token-conventions` passes in isolation and on clean rerun.)
- **Real-Postgres 16 lane** (`wrightful-pg` container, throwaway DB): `src/__tests__/pg-integration/`
  75 passed with `--no-file-parallelism` — the authoritative check for the new raw SQL (pglite
  hides int8-as-string and dialect errors).
- **Migrations** (all additive, pre-launch): `20260711160102_right_sentinel.sql` (§2.1
  `githubCheckClaimedAt`), `20260711220029_careless_sentinel.sql` (§5 four `CREATE INDEX`).
