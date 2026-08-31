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

## Run identity, reruns, matrices, and shards

The reporter derives one idempotency key for each logical CI execution. That
lets transport retries and native Playwright shards converge without merging
unrelated jobs:

- The base identity is the provider's build id plus its job name.
- On GitHub Actions, `GITHUB_RUN_ATTEMPT` is included automatically for
  non-sharded runs. A native-shard rerun is fail-closed because GitHub does not
  expose whether the user reran every shard or only one failed job: attempt 2+
  does not stream unless `WRIGHTFUL_IDEMPOTENCY_KEY` is explicitly shared by
  the complete shard set. This prevents a one-shard rerun from opening a
  dashboard run that can never finalize.
- On GitLab, non-sharded jobs include `CI_JOB_ID`, so retrying a job creates a
  new dashboard run instead of hitting the previous terminal key. Native
  shards deliberately keep the shared pipeline/job-group identity. GitLab does
  not expose a retry generation shared by a complete shard set, so retry the
  full pipeline rather than an individual sharded job.
- The selected Playwright project-name set is included automatically, even for
  native shards and empty/filtered suites. This keeps independent project
  matrices separate even though `GITHUB_JOB` is the same unexpanded job id in
  every leg, while shards of the same selected project set still share one key.
- Set `WRIGHTFUL_MATRIX_KEY` to a stable serialization of any non-shard matrix
  axes the reporter cannot observe, such as an operating system or Node
  version. It must have the same value in every native shard that should merge.

`WRIGHTFUL_IDEMPOTENCY_KEY` is the escape hatch for orchestrators such as
synthetic monitors. It is used verbatim, without the automatic discriminators.
Keep it constant across retries and shards of one in-progress execution, but
use a new value for every new logical execution. Reusing a key after its run is
terminal is rejected rather than reopening and overwriting the stored result.
For a complete GitHub native-shard rerun, set it at the job level to a value
that contains the run id, run attempt, and every non-shard matrix coordinate
(but not the shard index), for example:

```yaml
env:
  WRIGHTFUL_IDEMPOTENCY_KEY: >-
    ${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.project }}-${{ matrix.os }}
```

### Matrices that shard the suite themselves

Playwright sets `config.shard` only under `--shard`. A matrix that slices the
suite some other way — one `--project` per leg, or spec paths, or a grep —
looks like a plain single run to the reporter, even when every leg shares one
`WRIGHTFUL_IDEMPOTENCY_KEY` and therefore one dashboard run. The dashboard then
finalizes that run on the **first** leg's `/complete`: it goes terminal (status
decided by whichever leg happened to finish first, run glyph no longer showing
progress) while the slower legs are still streaming into it, and any leg whose
`openRun` lands after that point is rejected with `409 ... already belongs to a
completed execution` and drops every result it has.

Declare the shard coordinates so those legs are treated as shards of one run:

```yaml
- name: Run Playwright tests
  # `strategy.job-index` is 0-based and GitHub expressions have no arithmetic,
  # so the 1-based coordinate is computed in the shell.
  run: |
    export WRIGHTFUL_SHARD_INDEX=$((JOB_INDEX + 1))
    npx playwright test --project=${{ matrix.project }}
  env:
    JOB_INDEX: ${{ strategy.job-index }}
    WRIGHTFUL_SHARD_TOTAL: ${{ strategy.job-total }}
    WRIGHTFUL_IDEMPOTENCY_KEY: ${{ github.run_id }}-${{ github.job }}-${{ github.run_attempt }}
```

The run then stays `running` until every leg has reported, its final status is
the worst leg's rather than the first's, `expectedTotalTests` sums across legs,
and each test row records the leg that produced it. Both variables are
required, with `1 <= index <= total`; a partial or nonsensical declaration
warns on stderr and falls back to the single-run shape rather than opening a run
that could never finalize. Playwright's `--shard` always takes precedence.

Every leg must report for the run to finalize. A leg killed by a job timeout or
cancellation still posts its own `interrupted` completion; one lost to `SIGKILL`
leaves the run `running` until the dashboard watchdog sweeps it.

| environment variable        | handling                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GITHUB_RUN_ATTEMPT`        | Auto-detected rerun attempt. Native-shard attempts after the first require an explicit complete-set key.         |
| `CI_JOB_ID`                 | Auto-detected GitLab retry identity for non-sharded jobs; intentionally excluded from native-shard identity.     |
| `WRIGHTFUL_MATRIX_KEY`      | Optional discriminator for non-shard matrix axes that auto-detection cannot distinguish.                         |
| `WRIGHTFUL_IDEMPOTENCY_KEY` | Full explicit override; must be unique per execution and shared by every native shard in that execution.         |
| `WRIGHTFUL_SHARD_INDEX`     | 1-based shard coordinate for a matrix that shards the suite without `--shard`. Requires `WRIGHTFUL_SHARD_TOTAL`. |
| `WRIGHTFUL_SHARD_TOTAL`     | How many legs the shared run must wait for before it may finalize. Requires `WRIGHTFUL_SHARD_INDEX`.             |

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

With `postPrComment: true`, the reporter upserts one sticky summary comment per
workflow leg on the PR when the run completes. It requires GitHub Actions context
(`GITHUB_ACTIONS=true`), a PR-triggered workflow (so the PR number is set),
a detected `repo`, and a `GITHUB_TOKEN` (or `WRIGHTFUL_GITHUB_TOKEN`) in env —
grant the workflow `permissions: pull-requests: write`. The comment is keyed by
a workflow/job/project/matrix-scoped hidden HTML marker, so rerunning the same
leg updates it in place without overwriting another leg's summary. Set
`WRIGHTFUL_MATRIX_KEY` for matrix axes Playwright cannot observe. Cross-fork PRs
get a read-only token (the POST 403s); that's logged and ignored — it never
fails the suite.

The project scope normally comes from the run URL. If a compatible older
dashboard omits that URL, the reporter adds a one-way HMAC discriminator
derived from the project-scoped Wrightful API key. The raw key and a reusable
plain hash of it are never written to the public comment.

The CI-token fallback is skipped for native Playwright shards because each
shard has only a partial summary and racing shard comments can report a false
aggregate. Configure the Wrightful GitHub App for a single comment posted from
the dashboard after the merged sharded run reaches its terminal state.

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
- **Attachments** (when `artifacts` is `'failed'` or `'all'`): file bytes sent
  through the upload URL returned by `/api/artifacts/register` — a dashboard
  worker route by default, or an off-host presigned R2 URL when direct R2 is
  configured. Attachment paths are resolved through `realpath` and rejected if
  they escape the project root, to guard against symlink exfiltration via a
  hostile `playwright.config.ts`. Inline body attachments (those without a
  `path`) are **not** uploaded.

For each run, the reporter also sends CI metadata auto-detected from
environment variables (GitHub Actions, GitLab CI, CircleCI, or generic
`CI=true`): provider, build ID, branch, commit SHA and message, PR number,
repo slug, and triggering actor. The provider job name and GitHub run attempt
participate in the derived idempotency key, as does the GitLab job id for a
non-sharded run, but are not sent as run metadata. When no CI env is present
these fields are sent as `null`.

### GitHub Actions `pull_request` builds

On `pull_request` / `pull_request_target` events GitHub checks out an
**ephemeral merge commit** ("Merge `<head>` into `<base>`") and points
`GITHUB_SHA` at it — not the commit you authored. The reporter reads the PR's
head SHA, title, and number from the event payload (`GITHUB_EVENT_PATH`) and:

- reports the **head commit's SHA** (not the merge commit's), and
- resolves the **commit message** in descending order of fidelity:
  1. the head commit's message, when you wrote it — read with `git log`, only
     available when that commit object is present locally;
  2. the **PR title** (always available from the event payload);
  3. the head commit's message when GitHub generated it — a bare
     `Merge <sha> into <sha>`, which is what the **"Update branch"** button
     pushes onto a PR head. A PR title outranks it, but it still beats nothing.
     A merge with a real subject or a hand-written body counts as yours and
     stays at (1);
  4. the merge commit's message (last resort).

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
