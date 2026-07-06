# Integration brief — stream our Playwright E2E runs to Wrightful

> **For the frontend repo** (the Next.js app with the `playwright-tests.yml` project-matrix
> suite). Tailored to that repo's actual setup as of the handoff — most of the wiring is already
> in place; the only required change is passing credentials in CI.

## What this gives us

Wrightful is our deployed Playwright test-reporting dashboard (on Cloudflare). The reporter
streams every test result **and its trace/screenshot/video** to it live as CI runs, and failing
tests get **in-app "Test Replay"** — the full Playwright Trace Viewer (DOM scrub, network,
console), self-hosted on the dashboard origin so trace bytes never leave to `trace.playwright.dev`.
One place for results + artifacts + flaky/diff analytics, replacing the Cypress Cloud dashboard.

## Already done — no action needed

`playwright.config.ts` is **already wired**:

- `@wrightful/reporter` is registered in all three reporter arrays (CI / `CLAUDE` / local), reading
  `url`, `token`, and `environment` from `process.env`.
- `use` already captures the artifacts replay needs: `trace: 'retain-on-failure'`,
  `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`.

So **install + Playwright config require no changes**. Just keep `@wrightful/reporter` on a
protocol-v3 version (`^0.1.1` / latest) — a stale major is rejected by the dashboard with a `409`.

## The one required change — pass credentials in CI

In `playwright-tests.yml`, the **Run Playwright tests** step has no `env:`, so in CI
`process.env.WRIGHTFUL_URL` / `WRIGHTFUL_TOKEN` are `undefined` and the reporter logs a warning and
**silently disables streaming**. Add the env block to that step:

```yaml
- name: Run Playwright tests
  run: npx playwright test --project=${{ matrix.project }} --workers=${{ matrix.workers }}
  env:
    WRIGHTFUL_URL: ${{ secrets.WRIGHTFUL_URL }}
    WRIGHTFUL_TOKEN: ${{ secrets.WRIGHTFUL_TOKEN }}
    NEXT_PUBLIC_ENV: stg # optional: tags runs by environment; match your .env.stg value
```

Then add two **GitHub repo secrets** (Settings → Secrets and variables → Actions):

| Secret            | What it is                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_URL`   | The deployed dashboard origin, e.g. `https://wrightful-dashboard.<subdomain>.workers.dev`                             |
| `WRIGHTFUL_TOKEN` | A project-scoped API key (`wrf_…`), minted in the dashboard at `/settings/teams/<team>/p/<project>/keys`. Shown once. |

`NEXT_PUBLIC_ENV` is optional — the reporter reads it for the run's `environment` tag in the
dashboard; set it to whatever `environments/.env.stg` uses (or drop the line to leave runs untagged).

That's the whole change. Install ✔, config ✔, traces ✔ — only the env wiring + secrets remain.

## How the 12-project matrix maps to runs

The suite runs a **project matrix** (12 parallel jobs), not Playwright `--shard`. Every leg shares
the same `GITHUB_RUN_ID` + `GITHUB_JOB` (`playwright-tests`), so the reporter derives an identical
idempotency key and they **merge into one Wrightful run per CI run** (all projects aggregated). The
dashboard's `completeRun` does an atomic **monotonic status merge** (`greatest(completedAt)`,
worst-status-wins) explicitly designed for this "shards share one key" shape, so legs finishing at
very different times resolve correctly to a single run.

- **Expect:** the run may briefly show "complete" when the fastest project (e.g. `chromium-no-auth`)
  finishes, then keep updating as slower serial projects (up to ~30 min) stream in. Harmless — same
  as native sharding.
- **Prefer one run per project instead?** Add `WRIGHTFUL_IDEMPOTENCY_KEY: ${{ github.run_id }}-${{ matrix.project }}`
  to the same `env:` block → 12 runs/PR, cleaner per-project completion, but more clutter. Omitting
  it (one aggregated run) is the recommended default.

## Two deliberate non-changes

- We already post a PR summary via `daun/playwright-report-summary` in the `merge-reports` job, so
  **leave Wrightful's `postPrComment` off** (it already is) — no duplicate comments.
- GitHub **"Re-run"** reuses `run_id`, so a re-run re-opens and merges into the **same** Wrightful
  run (re-armed via `openRun`). Usually what you want; if not, the per-project key above also
  separates attempts when combined with `github.run_attempt`.

## Verify it worked

1. Open a PR to `master`/`develop`/`release-sup` (or add the `e2e-tests` label) to trigger the suite.
2. A matrix leg's **Run Playwright tests** log shows the reporter opening a run — no
   `WRIGHTFUL_URL not set` warning and no `409`.
3. The run appears in the dashboard and aggregates all projects' tests live.
4. Open a **failed** test → **Test Replay** → the embedded viewer loads from
   `…/trace-viewer/index.html?trace=…` on the dashboard origin (not `trace.playwright.dev`) and the
   DOM / Network / Console tabs populate.

## Troubleshooting

| Symptom                                         | Cause / fix                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI log: `409` / version error                   | Installed reporter major is older than the dashboard's protocol (v3). Upgrade `@wrightful/reporter`.                                                      |
| `WRIGHTFUL_URL not set`, streaming disabled     | The `env:` block wasn't added to the **Run Playwright tests** step, or the secrets are missing/misspelled.                                                |
| Run appears but **Test Replay** is empty/absent | No trace captured. `use.trace` is already `retain-on-failure`, so confirm the test actually failed (default artifact mode uploads only on failure/flaky). |
| `401 Unauthorized` on ingest                    | `WRIGHTFUL_TOKEN` is wrong/revoked or minted for a different project. Mint a fresh key.                                                                   |
| Projects show up as separate runs unexpectedly  | A `WRIGHTFUL_IDEMPOTENCY_KEY` with a per-leg discriminator is set; remove it to aggregate into one run.                                                   |

## Reference

- Reporter env/idempotency/artifacts: `@wrightful/reporter` (npm); idempotency logic in `ci.ts`.
- Dashboard API key minting: `/settings/teams/<team>/p/<project>/keys`.
- Example full workflow: the Wrightful repo's `examples/github-actions-workflow.yml`.
