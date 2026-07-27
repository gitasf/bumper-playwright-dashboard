# 2026-07-27 — Generated merge messages as run titles

Runs were landing on the dashboard titled with two 40-character object names:

> `Merge cc43127cdd579151635f1dd287882da6b28cd24d into 848b9f3ed98160960c5a7010b5c09326776c493f`

That string says strictly less than the branch, PR, sha, and env pills rendered
beside it, and at `text-body-lg` it was the visual anchor of every affected row.

## Cause

Not the ephemeral `refs/pull/N/merge` commit the reporter already worked around.
GitHub's **"Update branch"** button pushes a `Merge <sha> into <sha>` commit
_onto the PR head_, so the reporter's highest-fidelity source — the head commit's
own `git log` message — captured a message GitHub generated. The PR title, rank 2
in the chain and perfectly readable, was never reached.

## Changes

**Capture time** (`packages/reporter/src/ci.ts`, shipped separately in #16). A
generated merge message became its own rank in the fidelity chain rather than a
special case: demoted below the PR title, still ahead of nothing, so a run with
no PR title keeps the only message available instead of trading it for a
different useless one from `HEAD`. Detection is narrow — `Merge <sha> into <sha>`
and nothing else. `$` without `/m` matches end-of-input only, so testing the
whole message also rejects anything with a body; a merge with a real subject
(`Merge branch 'main' into fix/x`) or a hand-written body counts as authored.

**Render time** (this change), split into two layers:

- `commitTitle()` in `src/lib/text.ts` is the canonical reduction: `commitMessage`
  → `{ text, generated }`, the subject with generated-merge object names
  abbreviated to 7 chars plus whether the message carries human intent. It
  replaces `firstLine` as the entry point for commit messages — with both former
  `firstLine` callers migrated, that helper had no consumer left and folded into
  it.
- `CommitSubject` in `src/components/run/commit-subject.tsx` is the canonical
  _presentation_: it calls `commitTitle`, applies the de-emphasis when
  `generated`, carries the full-message `title=` tooltip, and renders a caller's
  `fallback` when there is no message. The `generated` flag never leaves that
  file, so no surface re-decides the styling.

All six surfaces that show a run's commit message now go through one of the two —
`CommitSubject` where weight matters (runs list, run detail `<h1>`, run hovercard,
test-history table) and `commitTitle().text` where only a string will do (the
runs-list screen-reader label, the command palette, and the test-result hovercard
footer, which is already metadata weight and gates on the subject's presence).
Before this split, the runs list rendered an abbreviated generated merge while the
history-bar hovercard _on the same page_ still rendered the raw 40-char string at
title weight.

De-emphasis is `font-mono font-normal text-fg-3` with no size token: each site
already picked the right scale, and mono at that scale beside non-mono siblings
reads as metadata on its own. One policy, no per-site knob to drift.

Two small behaviour changes fell out. The run-detail `<h1>` no longer sets its own
`title=` (`CommitSubject` owns the tooltip), so it also stops falling back to the
full run id on hover — that id is already visible as `#{shortId}` at the end of
the same row. And the command palette now matches on the subject rather than the
whole message, so matching runs over what the row displays.

The render fix is **not** redundant with the capture fix. The reporter's PR-title
fallback exists only on the GitHub Actions branch and only when a `pull_request`
payload is present. A **push event** — tests on `main` or a release branch after
a merge — has no payload, so `pr.title` is null and a generated message stays as
rank 3 by design. GitLab and CircleCI have no PR-title fallback at all. Those
runs are an ongoing stream, not a fixed set, so display-time normalization is the
only thing that covers them.

**Existing rows** (`scripts/backfill-run-titles.mjs`). Recovers the real PR title
from the GitHub API for rows written before the capture fix.

## Why the backfill is a script, not a migration

Resolving a title needs a network call per PR. Committed migrations run on every
environment, carry no secrets, and re-running against a fresh database is a
pointless no-op. A pure-SQL migration _could_ have abbreviated the shas in place
(`regexp_replace`), but that destroys the original message and only fixes a
snapshot — it does nothing for the push-event runs above.

The script is dry-run by default, groups runs by `(repo, prNumber)` so each PR is
fetched once, and re-asserts the generated-message predicate inside the `UPDATE`
so a concurrent write can't be clobbered by a title resolved for the row's older
state. That guard is what makes it idempotent and safe to re-run after a partial
failure. Rows with no `repo`/`prNumber` are counted and reported separately so
the summary never implies full coverage.

**It is marked for deletion once it has run successfully.** It is committed so
the change to production data is reviewable here rather than living only in
someone's shell history; that reason expires on completion.

The connection-string helpers it needs now live in `scripts/lib/pg-url.mjs`
alongside the existing `lib/spinner.mjs` / `lib/dev-server.mjs` / `lib/probe-status.mjs`,
shared with `migrate-remote.mjs`. Both are pure functions and `scripts/lib/` was
already the established home, so the extraction was mechanical — cheaper than a
second copy, and it leaves nothing behind when the backfill is deleted.

`--repo` with a missing or `--`-prefixed value now exits non-zero instead of
silently widening to every repo. The flag exists to narrow the blast radius, so
failing is the only safe direction for a typo.

## Duplicated rule

`GENERATED_MERGE_MESSAGE` exists three times by design: `packages/reporter/src/ci.ts`
(capture), `apps/dashboard/src/lib/text.ts` (render), and as a POSIX twin in the
backfill script (SQL). The reporter is a published standalone package, so neither
side can import the other, and the SQL copy has to be a Postgres regex.

The three were **not** in fact equivalent on first writing, and the gap is worth
recording. The dashboard copy trims before matching — `truncatedText`
(`src/lib/schemas.ts`) truncates without trimming, and the reporter's
`CI_COMMIT_MESSAGE` path passes the env var through as-is, so stored messages can
carry surrounding whitespace. The SQL copy did not trim. A padded generated merge
therefore rendered de-emphasized in the UI while being invisible to the backfill's
`WHERE` clause _and_ to its "no repo/PR recorded" count — the very count that
exists so the summary never implies full coverage. Every predicate in the script
now matches `btrim("commitMessage")`.

Nothing mechanical bound the copies, which is how that drifted. `commit-title.test.ts`
now reads the backfill script off disk and asserts its `GENERATED_MERGE_SQL`
literal is character-identical to this side's `RegExp.source` (minus the capture
parens), so editing either pattern fails the dashboard suite until both agree. The
case `skipIf`s itself when the script is absent, so it retires with the throwaway
rather than outliving it.

## Verification

- `apps/dashboard/src/__tests__/commit-title.test.ts` — 9 cases, including the
  SQL-twin drift guard (verified to fail when the script's pattern is edited)
- Reporter suite 308 passing; `pnpm check` exits 0
- Postgres `~*` predicate confirmed to match the JS regex on all six message shapes
- Backfill exercised end-to-end against a scratch database with 8 fixtures and
  **real** GitHub API calls: PR grouping (2 runs → 1 fetch), real titles resolved,
  dry run provably read-only, body/branch-merge/authored rows excluded, 404 PR
  counted without a write, and a second `--apply` updating 0 rows
- **Not yet run against production.**
- **The scratch-database run predates the `btrim` fix and the parameter reordering
  in the `UPDATE`.** Those three queries have not been re-exercised against a real
  Postgres — re-run the scratch fixtures (adding a whitespace-padded row, which
  the old predicate missed) before the production `--apply`.
- The `--repo` filter's narrowing branch is still untested (all fixtures shared one
  repo); its new missing-value guard is argument parsing only.
