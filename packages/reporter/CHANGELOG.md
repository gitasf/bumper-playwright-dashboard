# @wrightful/reporter

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
