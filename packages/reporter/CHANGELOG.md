# @wrightful/reporter

## 0.3.0

### Minor Changes

- 1cf2a8b: **Breaking:** every new execution now needs a distinct idempotency key.

  Reporter-generated keys fold in the GitHub run attempt, the selected Playwright
  project set, and an optional `WRIGHTFUL_MATRIX_KEY`, so a workflow rerun and
  independently-sharded browser-project jobs no longer collide with the execution
  they are retrying. Native shards of one job still converge on a single run.

  The dashboard now answers a reopened terminal key with `409` instead of
  rearming the completed run, so anything that deliberately reused one explicit
  `WRIGHTFUL_IDEMPOTENCY_KEY` across separate executions must generate a fresh
  value per execution. Reruns of a complete GitHub native-shard set must supply
  one fresh key shared by every shard; on GitLab, retry the full pipeline rather
  than an individual sharded job.

  Upgrade the reporter before the dashboard reaches this behaviour: a `0.2.x`
  reporter derives its key from `GITHUB_RUN_ID`, which is stable across reruns,
  so a rerun on the old reporter presents the completed run's key and is refused.

  Also fixes UTF-8 truncation to preserve mixed chunk order while decoding only
  bounded prefixes, and stops duration formatting rendering `60.0s`.

## 0.2.1

### Patch Changes

- eccdb22: Strip a trailing slash from `WRIGHTFUL_URL` / the `url` option so a value like
  `https://dash.example.com/` no longer builds `https://dash.example.com//api/runs`,
  which 404s on the dashboard and silently drops the whole run.

## 0.2.0

### Minor Changes

- 003f526: Report the real PR head commit on GitHub Actions `pull_request` builds instead
  of the ephemeral merge commit. The reporter now reads the PR head SHA from the
  event payload and resolves the commit message in descending fidelity: the real
  head-commit message (when the object is present — deepen the checkout with
  `fetch-depth: 0` to guarantee it), then the PR title, then the bare `git log`.
  The PR number is recorded as before.

  Hardened CI metadata detection: validate the head SHA as a git object name
  before passing it to `git log` (closes a `--output=`-style argument-injection
  vector on forked PRs), clamp identity fields to the dashboard's wire caps so an
  oversize value can't 400 the open-run call and lose the whole run, and guard
  every PR-number source against NaN/negative/non-integer values.

## 0.1.1

### Patch Changes

- 390087e: Add `default` export condition so Playwright's CJS-based reporter resolver can locate the package. Previously, `require.resolve("@wrightful/reporter")` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` because the exports map only declared `types` + `import` conditions.
