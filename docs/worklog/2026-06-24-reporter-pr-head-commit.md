# 2026-06-24 — Reporter prefers the PR head commit on `pull_request` events

## What changed

Runs triggered by GitHub Actions `pull_request` events were showing commit
metadata for the **ephemeral merge commit** GitHub fabricates for PR checkouts
(`Merge <head-sha> into <base-sha>`) instead of the commit the PR author
actually wrote. Every PR run in the dashboard listed an identical, useless
"Merge … into …" message, and `commitSha` pointed at the throwaway merge commit
rather than a real, navigable commit.

Cause: on `pull_request*` events GitHub sets `GITHUB_SHA` (and checks out HEAD)
to the synthetic merge commit. The reporter was reading `commitSha` from
`GITHUB_SHA` and `commitMessage` from a bare `git log -1` against that HEAD, so
both fields described the merge commit.

Fix (reporter-side, `packages/reporter/src/ci.ts`): on GitHub Actions, read the
PR head sha, **title**, and number from the event payload (`pull_request.*` in
`GITHUB_EVENT_PATH`) and:

- use the head sha for `commitSha` (falling back to `GITHUB_SHA` for push events
  / when the payload has no head sha), and
- resolve `commitMessage` in descending order of fidelity:
  1. the head commit's real message via `git log -1 --pretty=%B <headSha>` — only
     available when that commit object is present locally;
  2. the **PR title** from the event payload — always available, human-readable;
  3. the bare `git log` (the merge commit) as a last resort.

The `prNumber` association is unchanged — it was already captured and sent, so
each run already records the PR it belongs to.

This is a code-side fix so it works regardless of a user's `actions/checkout`
config, rather than requiring every consumer to override the checkout ref.

The PR-title fallback (step 2) is how Currents' `@currents/playwright` stays
zero-config: the event payload never carries the head commit's _message_, only
its title, so the title is the best human-readable string available without a
deeper checkout. (Cypress requires a manual `COMMIT_INFO_MESSAGE` env override or
a checkout change; TestDino uses a server-side GitHub App instead.)

## Details

- Refactored the event-payload read into one `readGithubPullRequest()` helper
  returning `{ number, headSha, title }`; `githubPrNumber()` now takes that
  result instead of re-reading the file. No change to PR-number precedence
  (`refs/pull/N/merge` ref still wins over the payload).
- `readGitCommitMessage()` now takes an optional `ref` argument.
- README: added a "GitHub Actions `pull_request` builds" subsection documenting
  the SHA/message resolution and the `fetch-depth` tip.

### Known limitation (documented in-code + README)

Reading the **head commit's real message** requires that commit object to be
present in the local clone. The default shallow PR checkout (`actions/checkout`
`fetch-depth: 1` on the merge ref) fetches only the merge commit, so
`git log <headSha>` fails — but the run now still gets the **PR title** (step 2)
as a readable fallback, and `commitSha` is still corrected to the head sha. To
record the literal commit message instead of the PR title, deepen the checkout
(`fetch-depth: 0`, or `2`). This tradeoff is noted in a comment in `detectCI()`
and in the README.

### Hardening pass (adversarial review of `ci.ts`)

A focused review of `ci.ts` (it runs in untrusted CI and shells out to `git`,
and must never throw nor emit a payload the dashboard 400s on) surfaced three
real issues, all fixed:

- **`git log` argument injection (security).** `head.sha` from the event payload
  is attacker-influenceable on `pull_request_target` / forked PRs and was passed
  to `git log` as a positional arg. `execFileSync` uses no shell, so there's no
  shell injection — but a value like `--output=/path` is parsed by **git** as an
  option and would write to an arbitrary file. Fixed by validating the head sha
  against `/^[0-9a-f]{7,64}$/i` before use (a hex string can't be an option).
  Note: a `--` separator is **not** a fix — `git log … -- <sha>` treats `<sha>`
  as a pathspec, not a revision (verified: returns empty), which would also have
  silently broken the real-message path.
- **Whole-run loss on oversize identity fields.** `commitSha` / `branch` / `repo`
  / `actor` / `ciBuildId` are `reject`-on-oversize in the dashboard's Zod schema
  (not truncated like `commitMessage`), and a 400 on open is non-retryable — it
  loses the entire run. These are now clamped to the dashboard's `MAX.SHORT` /
  `MAX.NAME` caps before emission, mirrored as `MAX_SHORT_FIELD_LENGTH` /
  `MAX_NAME_FIELD_LENGTH` and pinned `=== DASHBOARD_MAX` in `contract.test.ts`
  (same drift-guard pattern as `MAX_IDEMPOTENCY_KEY_LENGTH`).
- **`prNumber` NaN/negative/float → 400.** `prNumber` is `z.number().int().min(0)`;
  a non-numeric `CI_MERGE_REQUEST_IID` produced `NaN` (which `z.number()` rejects)
  and a hostile/odd payload `number` could be negative or fractional. All PR-number
  sources now funnel through a `safePrNumber` (`Number.isInteger && >= 0`) guard.

Also added a 5s `timeout` to the `git log` call (defense against a hung git;
stdin was already ignored) and normalized whitespace-only PR titles to `null`.

A second, lower-severity pass addressed the remaining review nits (each
validated first):

- **Bounded event-file read.** `GITHUB_EVENT_PATH` was read whole before
  `JSON.parse`. The path is runner-controlled and GitHub caps webhook payloads
  at 25 MiB, so this is belt-and-suspenders — a `statSync` size check (cap
  25 MiB) now skips a pathological/corrupt file instead of loading it.
- **Comment accuracy (`githubPrNumber`).** The old comment claimed `merge_group`
  events recover a PR number from the payload; they don't (no `pull_request`
  key). Corrected to list only `pull_request_target` as the payload-recovery
  case, with push / merge_group / workflow_dispatch staying null.
- **Documented the load-bearing `|| null`** in `readGitCommitMessage` — the `??`
  message-precedence chain depends on an empty git message being nullish.

The review also flagged that the proposed `--` separator fix was wrong for
`git log` semantics — confirmed before implementing and used hex validation
instead.

## Verification

- `pnpm --filter @wrightful/reporter test` — **272 passed** (16 files). Added,
  beyond the head-commit cases: non-hex head sha is ignored (injection guard);
  oversize sha/branch/repo are clamped to the caps; oversize event file is
  skipped before parse; negative/float payload PR number → null; non-numeric
  `CI_MERGE_REQUEST_IID` → null; negative `CIRCLE_PR_NUMBER` falls back to the PR
  URL; whitespace-only PR title → git fallback. `contract.test.ts` pins the new
  caps `=== DASHBOARD_MAX`.
- `pnpm check` — 0 errors (pre-existing `client.ts` warnings unrelated).
