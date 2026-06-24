# Integration brief — stream this repo's Playwright runs to Wrightful

> **For the engineer / agent working in the _consumer_ repo** (the frontend repo whose
> GitHub Actions Playwright suite should report into our Wrightful dashboard). This is
> self-contained — you do not need access to the Wrightful repo to follow it.

## What you're wiring up

Wrightful is our Playwright test-reporting dashboard (deployed on Cloudflare). Adding its
reporter to this repo streams every test result **and its trace/screenshot/video artifacts**
to the dashboard live as CI runs. Failed tests then get **in-app "Test Replay"** — the full
Playwright Trace Viewer (DOM scrub, network, console), self-hosted on our dashboard origin, so
trace bytes never leave to `trace.playwright.dev`.

The reporter is published on public npm as `@wrightful/reporter`. It authenticates with a
project-scoped Bearer API key and talks protocol **v3** to the dashboard.

## Two inputs you need first

Get these from whoever deployed the dashboard, and add them as **GitHub repository secrets**
(Settings → Secrets and variables → Actions):

| Secret            | What it is                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_URL`   | The deployed dashboard origin, e.g. `https://wrightful-dashboard.<subdomain>.workers.dev`                             |
| `WRIGHTFUL_TOKEN` | A project-scoped API key (`wrf_…`), minted in the dashboard at `/settings/teams/<team>/p/<project>/keys`. Shown once. |

## Step 1 — Install the reporter

```bash
pnpm add -D @wrightful/reporter      # or: npm i -D / yarn add -D
```

Pin to a recent version (`^0.1.1` or `latest`). It must speak protocol v3 — an older major
would be rejected by the dashboard with a `409` (see Troubleshooting).

## Step 2 — Register the reporter in your Playwright config

Find this repo's `playwright.config.ts` (or `.js`) and **add** the Wrightful reporter alongside
whatever reporter you already use. Also make sure traces are captured — Test Replay reads the
`trace` artifact, so without a trace there is nothing to replay.

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  // keep your existing reporters; just add the Wrightful one
  reporter: [
    ["list"],
    ["@wrightful/reporter", { postPrComment: true }], // postPrComment optional, see Step 5
  ],
  use: {
    trace: "retain-on-failure", // required for Test Replay on failures
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
```

Notes:

- The reporter's default **artifact mode is `"failed"`** — it uploads traces/screenshots/videos
  only for failing and flaky tests (exactly what you replay). To also capture passing tests, use
  `["@wrightful/reporter", { artifacts: "all" }]` together with `trace: "on"` — this costs more
  artifact storage.
- If `WRIGHTFUL_URL` / `WRIGHTFUL_TOKEN` are unset (e.g. local runs), the reporter logs a warning
  and disables streaming — your tests still run normally. So you don't need to guard it per-env.

## Step 3 — Pass the credentials in the workflow

In the GitHub Actions workflow that runs Playwright, set the two env vars on the **test step**
(or job-level `env`):

```yaml
- name: Run Playwright tests
  run: npx playwright test # your existing command (sharded is fine)
  env:
    WRIGHTFUL_URL: ${{ secrets.WRIGHTFUL_URL }}
    WRIGHTFUL_TOKEN: ${{ secrets.WRIGHTFUL_TOKEN }}
```

## Step 4 — Sharding (nothing to do)

If you run Playwright with `--shard`, all shards of the same CI run **automatically merge into
one run** in the dashboard: the reporter derives a deterministic idempotency key from
`GITHUB_RUN_ID` (plus `GITHUB_JOB` to separate distinct matrix jobs). `--shard` is intentionally
_not_ part of the key. No per-shard configuration is needed.

## Step 5 — Optional: PR summary comment

With `postPrComment: true` (Step 2), the reporter upserts a single sticky summary comment on the
PR (pass/fail/flaky counts + a deep link to the run) on each push. To allow it:

```yaml
permissions:
  pull-requests: write          # required for the comment
# ...
    env:
      WRIGHTFUL_URL: ${{ secrets.WRIGHTFUL_URL }}
      WRIGHTFUL_TOKEN: ${{ secrets.WRIGHTFUL_TOKEN }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # reporter also accepts WRIGHTFUL_GITHUB_TOKEN
```

Fork PRs get a read-only token from GitHub, so the comment is skipped gracefully (the run still
streams). Leave `postPrComment` off if you don't want PR comments.

## Verify it worked

1. Open a PR (or push to a branch that triggers the suite).
2. The CI test step's logs should show the reporter opening a run (no `WRIGHTFUL_URL not set`
   warning, no `409`).
3. In the dashboard, the run appears under your team/project and updates live as tests finish.
4. Open a **failed** test → click **Test Replay** → the embedded viewer loads from
   `…/trace-viewer/index.html?trace=…` on the dashboard origin (not `trace.playwright.dev`) and
   the DOM / Network / Console tabs populate.
5. If `postPrComment` is on, the PR shows a "Wrightful — …" summary comment.

## Troubleshooting

| Symptom                                         | Cause / fix                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI log: `409` / version error                   | The installed reporter major is older than the dashboard's protocol (v3). Upgrade `@wrightful/reporter`.                                                       |
| `WRIGHTFUL_URL not set`, streaming disabled     | Secrets not wired to the step's `env`, or names misspelled.                                                                                                    |
| Run appears but **Test Replay** is empty/absent | No trace was captured. Ensure `use.trace` is `retain-on-failure` (or `on`) and the test actually failed (default artifact mode only uploads on failure/flaky). |
| `401 Unauthorized` on ingest                    | `WRIGHTFUL_TOKEN` is wrong/revoked, or minted for a different project. Mint a fresh key.                                                                       |
| PR comment missing                              | Needs `permissions: pull-requests: write` + `GITHUB_TOKEN` passed through; fork PRs are skipped by design.                                                     |

## Reference

- Reporter source of truth for env/idempotency/artifacts: `@wrightful/reporter` (npm).
- Dashboard API key minting: `/settings/teams/<team>/p/<project>/keys`.
- Example full workflow: the Wrightful repo's `examples/github-actions-workflow.yml`.
