# Sticky GitHub PR comment (App-posted run summary)

## What changed

The dashboard now upserts a single **sticky PR comment** for every completed
run that carries a `repo` + `prNumber`, alongside the existing check run. Check
runs are easy to miss in the PR UI; the comment is the summary teams actually
read. It renders:

- the check-run-parity headline + passed/failed/flaky/skipped/duration table;
- failures split **new vs. known** — new = failing here but passing/absent on
  the branch's previous terminal run, known = already failing there;
- **flaky detections** for this run (passed only after retry);
- deep links: each listed test → its test-result page, plus "View run report"
  and (when a baseline exists) "Compare to base" (`…/runs/:id/diff`);
- capped at 10 lines per section with an "…and N more" overflow.

New module `apps/dashboard/src/lib/github-pr-comment.ts`
(`maybePostGithubPrComment(runId, projectId)`), called best-effort (never
throws) from the same three terminal ingest paths as `maybePostGithubCheck`:
`completeRun`, `completeShardedRun` (only when all shards are done), and
`finalizeStaleRun`.

## Why dashboard-side / design notes

- Same rationale as the check run (`github-checks.ts` module doc): installation
  tokens work on fork PRs, the dashboard owns the authoritative aggregates, and
  watchdog-finalized runs never reach reporter `onEnd`. The reporter's
  CI-token `postPrComment` stays as the no-App fallback; distinct markers, so
  running both stacks two comments — SELF-HOSTING now says pick one.
- **Sticky identity is per PR, not per run** — new table `githubPrComments`
  keyed unique `(projectId, repo, prNumber)` storing the GitHub comment id.
  The DB row (not a marker scan) locates the comment; the
  `<!-- wrightful:pr-summary:<projectId> -->` marker is for human debugging and
  project disambiguation.
- **Race safety** mirrors the check-run claim: `claimedAt` claim-before-POST
  CAS (120s TTL) so concurrent completions of the same run never stack
  duplicate comments; POST failure releases the claim; PATCH 404 (a human
  deleted the comment) reposts fresh.
- **Stale-run guard**: `githubPrComments.runId` records which run the comment
  renders; run ids are ULIDs (time-ordered), so a watchdog finalizing an old
  push late declines instead of regressing the comment to stale content.
- **Baseline choice**: NOT `resolveBaseRun` (the diff page's last-_passed_
  anchor) — a passed baseline contains no failing rows, so "known failures"
  could never be non-empty. The comment resolves the most recent **terminal**
  run on the same branch (`resolveCommentBaseRun`) and feeds the existing pure
  `diffRuns` via `computeRunDiff`. Failing `addedTests` count as new failures.
  First run on a PR branch has no baseline → a single un-split "Failures"
  section. Possible future upgrade: diff against the PR's _target_ branch
  (needs the target branch, which ingest doesn't capture today).
- Tenancy: same confused-deputy boundary as checks — the installation lookup is
  scoped to the run's own `teamId`, never resolved from the attacker-controlled
  `repo` owner alone. The `TenantScope` for the diff queries is built from the
  trusted joined run row (same rationale as `finalizeStaleRun`).
- The GitHub App now needs **Pull requests: Read & write** (comments go through
  the issues API with an installation token). Without it the POST 403s — logged
  via `logger.error`, ingest unaffected.

## Migration

`20260717214015_nosy_daimon_hellstrom.sql` — creates `githubPrComments` with
FKs (`projectId` cascade, `runId` set-null) and the unique
`(projectId, repo, prNumber)` index.

## Files

- `apps/dashboard/src/lib/github-pr-comment.ts` — new (render + claim + post).
- `apps/dashboard/db/schema.ts` — `githubPrComments` table.
- `apps/dashboard/src/lib/github-checks.ts` — exported `formatDuration`.
- `apps/dashboard/src/lib/ingest.ts` — three call sites.
- `apps/dashboard/src/__tests__/github-pr-comment.workers.test.ts` — pure
  rendering/bucketing/path tests.
- `apps/dashboard/src/__tests__/github-pr-comment-claim.test.ts` — pglite
  integration: first-POST persist, PATCH + new-vs-known content end-to-end,
  claim race (exactly one POST), claim release on failure, stale-run guard,
  PATCH-404 repost, tenancy no-ops.
- `SELF-HOSTING.md`, `docs/ARCHITECTURE.md` — App permission + table docs.

## Verification

- `pnpm --filter @wrightful/dashboard test` — both lanes green (includes the
  20 new tests).
- `pnpm check` and `pnpm --filter @wrightful/dashboard typecheck` — clean.

## Follow-up: dedupe the check-run / PR-comment surfaces

A code-quality review found `github-pr-comment.ts` had been written by cloning
`github-checks.ts` rather than sharing with it. Refactored, intending zero
behavior change beyond two explicitly-accepted timing simplifications (below):

- **Shared run-surface orchestrator.** New `apps/dashboard/src/lib/
github-run-context.ts` resolves everything BOTH surfaces need for a
  completed run in one pass: the run row (a superset join of `runs` +
  `teams` + `projects` covering both surfaces' fields, including
  `prNumber`/`branch`/`createdAt`), `parseRepoOwner`, the team-scoped
  `githubInstallations` lookup (the confused-deputy authorization boundary —
  its full rationale comment now lives here, the single enforcement site),
  and a minted installation token — as `resolveGithubRunContext(runId,
projectId): Promise<GithubRunContext | null>`. New
  `apps/dashboard/src/lib/github-run-surfaces.ts` exports the single entry
  point `postGithubRunSurfaces(runId, projectId)` that resolves this context
  once and posts both surfaces via `Promise.all`; `ingest.ts`'s three call
  sites (`completeRun`, `completeShardedRun`, `finalizeStaleRun`) now make one
  awaited call each instead of two sequential ones.
  - Context resolution and the orchestrator are split across TWO files (not
    one) specifically to keep the module graph a DAG: `github-checks.ts` and
    `github-pr-comment.ts` each import `resolveGithubRunContext` from the leaf
    `github-run-context.ts` for their own standalone `maybePostGithubCheck` /
    `maybePostGithubPrComment` entry points, and `github-run-surfaces.ts`
    imports from all three. Folding context resolution into
    `github-run-surfaces.ts` alongside the orchestrator would have made
    `github-checks.ts` and `github-pr-comment.ts` import FROM it while it
    imports THEIR `post*Surface` functions — a cycle oxlint's `import(no-cycle)`
    correctly flags as a hard error.
  - `github-checks.ts` / `github-pr-comment.ts` were refactored into
    `postCheckRunSurface(context)` / `postPrCommentSurface(context)` (the
    claim-before-POST logic, render, and POST/PATCH target — genuinely each
    surface's own, unchanged) plus thin `maybePostGithubCheck` /
    `maybePostGithubPrComment(runId, projectId)` wrappers that resolve context
    and delegate — kept at their original names/signatures for the existing
    claim-concurrency tests and any future standalone caller. Each surface
    keeps its OWN try/catch + `logger.error` envelope, so a check-run failure
    never suppresses the PR comment or vice versa.
  - **Accepted behavior changes** (both from minting once instead of once per
    surface):
    1. A shared token-mint failure is now logged ONCE
       (`"github run-context resolution failed"`) and skips BOTH surfaces,
       instead of the check surface logging its own mint failure while the
       comment surface separately re-mints and proceeds.
    2. The token is now minted BEFORE either surface's claim decision (claim
       TTL is 120s, comfortably covering it), so a caller that loses a claim
       race, or finds a fresh live claim held by someone else, still mints a
       token it ends up not using. Previously mint happened strictly after a
       successful claim. Within each surface the claim-before-POST ordering
       itself (claim → GitHub POST/PATCH → persist/release) is unchanged.
       `github-checks-claim.test.ts` / `github-pr-comment-claim.test.ts` had
       two `mintInstallationToken` call-count assertions each that assumed the
       old mint-after-claim timing; updated in place with comments explaining
       the new expected counts — no other assertion in either file changed.
  - `resolveCommentBaseRun` (github-pr-comment.ts) was a near-verbatim copy of
    `resolveBaseRun` (`run-diff.ts`), differing only in which statuses count as
    a baseline. `resolveBaseRun` now takes an `opts.statuses` param (default
    `["passed"]`); the PR-comment path passes the new
    `TERMINAL_RUN_STATUSES` const (`schemas.ts`, derived into
    `CompleteRunPayloadSchema`'s `z.enum` so the two can't drift) so failures
    already present on the previous push's run classify as known. The local
    copy is deleted.
  - `buildCheckRunOutput`'s title ternary and 3-line stats table are now
    `runHeadline` / `runSummaryTable`, exported from `github-checks.ts` next to
    `formatDuration` and reused by `buildPrCommentBody` — the
    "check-run headline parity" test now holds by construction instead of by
    copy-paste.
  - `github-pr-comment-claim.test.ts`'s hand-rolled `pgType`/`createTableSql`
    are gone in favor of `resetTables`/`createTableSql` from
    `pg-integration/harness.ts` (matching every other pglite integration test);
    the unique `(projectId, repo, prNumber)` index — not expressible by the
    harness's column-only DDL — is still created separately, as before.
    `github-checks-claim.test.ts` / `sharded-complete.test.ts` were left on
    their existing local-DDL pattern (out of scope for this pass).
  - Minor: `bucketListedResults` no longer builds its `byTestId` lookup Map on
    the no-diff early-return path (it was unused there); the stale-run guard
    in `github-pr-comment.ts` gained a one-line comment on the ULID-ordering
    invariant it relies on.

### Files (follow-up)

- `apps/dashboard/src/lib/github-run-context.ts` — new; `GithubRunContext` +
  `resolveGithubRunContext`.
- `apps/dashboard/src/lib/github-run-surfaces.ts` — new; `postGithubRunSurfaces`.
- `apps/dashboard/src/lib/github-checks.ts`,
  `apps/dashboard/src/lib/github-pr-comment.ts` — split into `post*Surface`
  (context-taking) + thin `maybePost*` wrappers; shared `runHeadline` /
  `runSummaryTable`.
- `apps/dashboard/src/lib/run-diff.ts` — `resolveBaseRun(scope, headRun, opts?)`.
- `apps/dashboard/src/lib/schemas.ts` — `TERMINAL_RUN_STATUSES`.
- `apps/dashboard/src/lib/ingest.ts` — three call sites now call
  `postGithubRunSurfaces`.
- `apps/dashboard/src/__tests__/github-checks-claim.test.ts`,
  `apps/dashboard/src/__tests__/github-pr-comment-claim.test.ts` — two
  mint-call-count assertions each updated for the new mint-before-claim timing;
  the latter also now uses the shared pglite harness.
- `apps/dashboard/src/__tests__/run-diff.workers.test.ts` — the
  `resolveBaseRun` scoping test asserts `inArray(status, [...])` instead of
  `eq(status, "passed")`.
- `apps/dashboard/src/__tests__/ingest-pipeline.workers.test.ts` — a comment
  updated to name `postGithubRunSurfaces`.

### Verification (follow-up)

- `pnpm --filter @wrightful/dashboard test` — both lanes green: 615 + 4 skipped
  (Node) and 1352 (workers) — no regressions.
- `pnpm --filter @wrightful/reporter test` — 300 passed, unaffected.
- `pnpm check` — 0 errors (141 pre-existing warnings in untouched files, none
  new).

## Follow-up 2: shared claim lifecycle + wrapper deletion (review pass)

A structural review of the first follow-up found it had stopped one move short:
the claim-before-POST state machine was still cloned across both surfaces, and
the `maybePostGithubCheck` / `maybePostGithubPrComment` wrappers had zero
production callers (kept only for the claim tests). Addressed:

- **`src/lib/github-surface-post.ts` (new).** `postWithClaimedSlot(surface,
runId, initialId, io, post)` owns the correctness-critical ordering both
  surfaces previously duplicated — claim the POST slot, re-read the external
  id after a lost race, release the claim on a failed POST (CAS on the token),
  persist the posted id — with each surface supplying four single-query
  `ClaimedSlotIO` operations against its own table. Also hosts
  `githubWriteId` (POST/PATCH → throw on non-2xx → parse `{id}`), the fetch
  envelope both surfaces previously duplicated; it lives here rather than in
  `github-http.ts` so it calls the _imported_ `githubFetch` binding the claim
  tests mock. The PR comment's PATCH-404-repost branch stays local to
  `postComment` (it needs the 404/ok distinction).
- **`src/lib/github-run-render.ts` (new).** `statusToConclusion`,
  `formatDuration`, `runHeadline`, `runSummaryTable` moved out of
  `github-checks.ts` — the PR-comment surface no longer imports pure render
  helpers from its peer surface module.
- **Wrappers deleted.** `maybePostGithubCheck` / `maybePostGithubPrComment`
  are gone; `postGithubRunSurfaces` is the single production entry point, and
  the surface modules now import `GithubRunContext` type-only (the runtime
  leaf-module constraint, and its DAG doc essay, went away with the wrappers).
  This also removes an inconsistency where the same resolution failure logged
  different messages depending on entry point.
- **`resolveGithubRunContext`** returns null early when the run has neither a
  `commitSha` nor a `prNumber` (no surface could post — skips the
  installation lookup and token mint), and the hand-copied 20-field return
  literal collapsed into a destructure + spread of the row.
- **Accepted behavior change:** on the PR-comment path, content assembly
  (`buildContent`) now runs inside the shared post step, so a DB failure
  while building the comment body releases a held claim instead of leaking it
  until the 120s TTL. Claim/POST/persist ordering is otherwise unchanged.
- **Tests.** `github-checks-claim.test.ts` now drives the production entry
  point `postGithubRunSurfaces` (its fixtures have no `prNumber`, so the
  comment surface no-ops) and uses the shared `resetTables` harness instead
  of its local DDL. `github-pr-comment-claim.test.ts` composes
  `resolveGithubRunContext` + `postPrCommentSurface` directly (its fixtures
  carry a `commitSha`, so the orchestrator would also fire the check-run
  surface into the mocked fetch). No assertion values changed.

## Follow-up 3: PR-comment write mutex (PR #60 review pass, 2026-07-20)

Codex flagged (P1) that the sticky comment — ONE GitHub resource shared by
every run on a PR — was only claim-protected for the FIRST POST. Two distinct
runs finishing concurrently could (a) PATCH the comment concurrently, so the
older run's body could land last at GitHub even though the DB `runId` CAS kept
the newer id, and (b) on the very first comment, a newer run that lost the
POST claim returned without retrying, stranding the comment on the older run.

- **`postWithWriteMutex` (new, `src/lib/github-surface-post.ts`).** The
  sticky-comment surface now serializes EVERY write (first POST and later
  PATCHes) on the row's claim column: claim → re-read under the mutex →
  write → persist `{commentId, runId}` (CAS on the claim) → release. A caller
  that loses the claim waits and retries, bounded
  (`4 attempts × 1.5s` — so a crashed holder's unexpired claim costs ingest
  at most ~4.5s, not the 120s TTL). The persisted `runId` doubles as the
  monotonic guard: a caller observing `runId >= its own` skips, which also
  dedupes retried finalizes of the same run. `claimPrCommentSlot` dropped its
  `commentId IS NULL` predicate (claim = write mutex now, not first-POST
  slot); the persist-time `runId` OR-guard collapsed into the claim CAS.
- **Check-run surface unchanged** on `postWithClaimedSlot`: the check run is
  per-run, so concurrent posters render identical content and PATCH races are
  benign. Both flows now release a held claim when GitHub's 2xx response
  carries no id (CodeRabbit; previously that leaked the claim for the TTL).
- **`formatDuration`** rounds to the displayed tenth before the `< 60`
  comparison, so 59.96s renders `1m 0s` instead of `60.0s` (CodeRabbit).
- **Tests.** `github-pr-comment-claim.test.ts` adds both cross-run races
  (first-comment POST race and concurrent PATCHes; asserts the newest run's
  body is the LAST write to reach GitHub in every interleaving). New
  `github-surface-post.workers.test.ts` covers the fake-IO branches pglite
  can't reach deterministically (mutex give-up, no-id release, rethrow).
  Claim tests import schema via `@schema` per repo convention.

### Addendum: PR-scoped diff baseline (Codex P2)

Branch names are not unique across PRs — two fork PRs can both report head
ref `fix` while `run.repo` stays the target repository — so the PR comment's
branch-only `resolveBaseRun` could adopt an unrelated PR's terminal run as
its baseline and mislabel failures as known-vs-new. `resolveBaseRun` grew an
optional `pr: { repo, prNumber }` predicate; the PR-comment path passes it,
the diff page keeps the branch-wide default. Covered by a pglite test
(same-branch run on another PR must not become the baseline).

### Addendum: lost initial-POST recovery (Codex P2)

An initial comment POST whose 2xx response is lost in transit leaves the
comment on GitHub with no persisted id, so the next completed run's fresh
POST would create a duplicate marker comment. Before any fresh POST the
surface now scans one page of the PR's issue comments for the project-scoped
marker and adopts (PATCHes) a hit instead of creating a new comment —
mirroring the reporter's `findExistingComment`, except a failed listing
throws (fail closed) rather than falling through to POST: the flaky-network
conditions that break the listing are exactly the ones that lose POST
responses, and the claim release means the next run retries. Covered by a
pglite test (GET → PATCH of the recovered id, no POST).

### Addendum: code-span sanitization for untrusted text (Codex P2)

`t.file` (and the commit shas) were interpolated into the comment's Markdown
code spans raw. Git permits backticks and newlines in path components, so a
hostile test filename could close the span and inject arbitrary Markdown —
including @-mentions — into the App-posted comment. `mdCodeSpanText` now
strips backticks (backslash escapes don't work inside code spans) and
collapses whitespace runs before interpolation; shas sanitize before the
7-char slice so a stripped backtick can't shorten the displayed prefix.
Titles were already covered by `escapeMdLinkText`.
