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

| option            | default               | notes                                                                |
| ----------------- | --------------------- | -------------------------------------------------------------------- |
| `url`             | `WRIGHTFUL_URL` env   | Dashboard base URL                                                   |
| `token`           | `WRIGHTFUL_TOKEN` env | Bearer API key — project-scoped; mint from the dashboard's keys page |
| `batchSize`       | `20`                  | Max results per flush                                                |
| `flushIntervalMs` | `500`                 | Max ms to wait between flushes                                       |
| `environment`     | —                     | Environment tag for the run                                          |
| `artifacts`       | `'failed'`            | Which tests' attachments to upload: `'all' \| 'failed' \| 'none'`    |

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

Semantics match the CLI's `--artifacts` flag. Per-file failures are logged
to stderr and do not block the run or other artifact uploads.

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

Error messages and stack traces can echo the values your tests interacted
with (payloads, environment values, file paths). If your assertions can
touch secrets, they'll be visible in the dashboard — scope API keys and
project access accordingly.

The reporter never reads or transmits `WRIGHTFUL_TOKEN` or any other
environment variable content outside the fields listed above.

## Retried tests

Retried tests are aggregated into one row at their final outcome — a
fails-then-passes test streams as a single `flaky` row (not two separate
attempts), matching the bulk CLI upload. Non-retried tests stream as soon as
their single attempt completes.
