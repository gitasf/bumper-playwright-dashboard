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

## Existing rows

Deliberately not repaired. A backfill (fetching each PR's real title from the
GitHub API and rewriting `commitMessage`) was written and then dropped: it needs
direct access to the production Postgres origin behind Hyperdrive, which nobody
on the team currently holds — `db:migrate:remote` has never been run — and it
would have overwritten the stored message irreversibly to fix a fixed snapshot.
Render-time normalization already makes those rows readable, so the repair buys
only the difference between an abbreviated `Merge cc43127 into 848b9f3` and the
PR title.

Worth revisiting only if that difference starts mattering, and then via the
Worker's own Hyperdrive binding (a temporary admin route) rather than a laptop
script, since that needs no credentials nobody has.

## Duplicated rule

`GENERATED_MERGE_MESSAGE` exists twice by design: `packages/reporter/src/ci.ts`
(capture) and `apps/dashboard/src/lib/text.ts` (render). The reporter is a
published standalone package, so neither side can import the other.

The two are not quite identical, which is worth recording: the dashboard copy
trims before matching. `truncatedText` (`src/lib/schemas.ts`) truncates without
trimming and the reporter's `CI_COMMIT_MESSAGE` path passes the env var through
as-is, so stored messages can carry surrounding whitespace, whereas the reporter
matches `readGitCommitMessage` output that is already trimmed-or-null.

## Verification

- `apps/dashboard/src/__tests__/commit-title.test.ts` — 8 cases
- Reporter suite 308 passing; `pnpm check` exits 0
