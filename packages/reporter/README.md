# @wrightful/reporter

Playwright reporter that streams test results to your Wrightful dashboard as
each test completes, so results appear live instead of only at the end of the
CI run.

## Install

```bash
pnpm add -D @wrightful/reporter
```

## Usage

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["list"],
    [
      "@wrightful/reporter",
      {
        url: process.env.WRIGHTFUL_URL,
        token: process.env.WRIGHTFUL_TOKEN,
        environment: "ci",
      },
    ],
  ],
});
```

Options:

| option              | default               | notes                                                                                                                                                                                                            |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`               | `WRIGHTFUL_URL` env   | Dashboard base URL                                                                                                                                                                                               |
| `token`             | `WRIGHTFUL_TOKEN` env | Bearer API key — project-scoped; mint from the dashboard's keys page                                                                                                                                             |
| `batchSize`         | `20`                  | Max results per flush                                                                                                                                                                                            |
| `flushIntervalMs`   | `500`                 | Max ms to wait between flushes                                                                                                                                                                                   |
| `environment`       | —                     | Environment tag for the run                                                                                                                                                                                      |
| `artifacts`         | `'failed'`            | Which tests' attachments to upload: `'all' \| 'failed' \| 'none'`                                                                                                                                                |
| `shutdownTimeoutMs` | `600000` (10 min)     | Wall-clock budget for the `onEnd` drain (pending batches + in-flight uploads), with a slice reserved for `/complete`. On expiry the reporter completes the run anyway, so a slow dashboard can't hang the suite. |
| `postPrComment`     | `false`               | Upsert a sticky GitHub PR summary comment when the run completes (see [GitHub PR comment](#github-pr-comment)).                                                                                                  |

## Protocol

Every request carries `X-Wrightful-Version: 3`. The dashboard rejects older
versions with `409 Conflict`, so reporter and dashboard must be upgraded
together across protocol bumps.

## Fail-closed semantics

The reporter never fails the Playwright suite. On error:

- Network / 5xx / 429 errors on open/append/complete/register calls are
  retried with exponential backoff (up to 3 attempts; 6 for the final
  `/complete` call). Each attempt is capped by a 30s timeout (120s for
  artifact PUTs).
- Auth errors (401/403) are **not** retried — the warning includes a hint
  to check `WRIGHTFUL_TOKEN`.
- Per-file artifact PUT failures are bounded: other uploads continue.
- An end-of-suite summary line reports how many tests streamed and how
  many artifacts uploaded.

**If `completeRun` fails after all retries, or the CI process is killed
before `onEnd` fires** (SIGKILL from the GitHub Actions cancel button,
OOM, infra teardown), the run will stay at `status='running'` briefly.
The dashboard's cron watchdog sweeps stuck runs every 5 minutes and marks
them `'interrupted'` once they're older than the configured threshold
(default 30 min, overridable via `WRIGHTFUL_RUN_STALE_MINUTES`).

SIGTERM (graceful cancellation) triggers a best-effort `/complete` with
`status='interrupted'` before exit, so typical CI cancellations get a
clean finalize without waiting for the watchdog.

## Artifacts

Attachments (traces, screenshots, videos) are uploaded incrementally as each
test completes — no separate `wrightful upload` pass required. Upload scope
follows the `artifacts` option:

- `'failed'` (default): upload for unexpected failures + flaky retries.
- `'all'`: upload for every test.
- `'none'`: skip artifact uploads entirely.

Per-file failures are logged to stderr and do not block the run or other
artifact uploads.

## GitHub PR comment

With `postPrComment: true`, the reporter upserts a single sticky summary
comment on the PR when the run completes. It requires GitHub Actions context
(`GITHUB_ACTIONS=true`), a PR-triggered workflow (so the PR number is set),
a detected `repo`, and a `GITHUB_TOKEN` (or `WRIGHTFUL_GITHUB_TOKEN`) in env —
grant the workflow `permissions: pull-requests: write`. The comment is keyed by
a hidden HTML marker, so re-running the same workflow updates the existing
comment in place rather than posting a new one. Cross-fork PRs get a read-only
token (the POST 403s); that's logged and ignored — it never fails the suite.

## Quarantine

If the dashboard has quarantined any of the project's tests, the reporter
fetches that list at `onBegin` and reports a quarantined test's _hard failure_
as `skipped` (with a `quarantined` annotation) instead — observe-only
enforcement, since a reporter can't stop a test from running. A `passed` or
already-`skipped` outcome is left untouched. The fetch is best-effort: if it
fails, quarantine is simply a no-op for that run.

## Data sent to the dashboard

For each test, the reporter sends:

- **Test identity**: file path (relative to Playwright's `rootDir`), title path,
  project name.
- **Outcome**: status, duration, retry count, and per-attempt status, error
  message, and error stack.
- **Tags and annotations** declared in your test code.
- **Attachments** (when `artifacts` is `'failed'` or `'all'`): file bytes
  streamed through the dashboard worker to R2 via the upload URL returned by
  `/api/artifacts/register`. Attachment paths are resolved through
  `realpath` and rejected if they escape the project root, to guard against
  symlink exfiltration via a hostile `playwright.config.ts`. Inline body
  attachments (those without a `path`) are **not** uploaded.

For each run, the reporter also sends CI metadata auto-detected from
environment variables (GitHub Actions, GitLab CI, CircleCI, or generic
`CI=true`): provider, build ID, branch, commit SHA and message, PR number,
repo slug, and triggering actor. When no CI env is present these fields are
sent as `null`.

### GitHub Actions `pull_request` builds

On `pull_request` / `pull_request_target` events GitHub checks out an
**ephemeral merge commit** ("Merge `<head>` into `<base>`") and points
`GITHUB_SHA` at it — not the commit you authored. The reporter reads the PR's
head SHA, title, and number from the event payload (`GITHUB_EVENT_PATH`) and:

- reports the **head commit's SHA** (not the merge commit's), and
- resolves the **commit message** in descending order of fidelity:
  1. the head commit's real message, read with `git log` — only available when
     that commit object is present locally;
  2. the **PR title** (always available from the event payload);
  3. the merge commit's message (last resort).

This needs **no workflow changes** — you'll get the right SHA and a readable
title out of the box. The default `actions/checkout` only fetches the merge
commit, so the head commit's _real_ message isn't reachable; to record it
instead of the PR title, deepen the checkout so the head commit is present:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # (or 2) — makes the PR head commit available to `git log`
```

If a **CODEOWNERS** file is present (`.github/CODEOWNERS`, then `CODEOWNERS`,
then `docs/CODEOWNERS` — GitHub's resolution order, first found wins), its
contents are attached to the open-run payload so the dashboard can derive
test ownership. Best-effort: a missing or oversized file is simply omitted.

Error messages and stack traces can echo the values your tests interacted
with (payloads, environment values, file paths). If your assertions can
touch secrets, they'll be visible in the dashboard — scope API keys and
project access accordingly.

The reporter never reads or transmits `WRIGHTFUL_TOKEN` or any other
environment variable content outside the fields listed above.

## Retried tests

Retried tests are aggregated into one row at their final outcome — a
fails-then-passes test streams as a single `flaky` row (not two separate
attempts). Non-retried tests stream as soon as their single attempt completes.
