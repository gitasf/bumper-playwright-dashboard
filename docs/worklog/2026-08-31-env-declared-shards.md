# Env-declared shards for matrices that slice a suite without `--shard`

## Why

A run on `bumper-e2e.dev` showed the failed glyph roughly two minutes into a
seventeen-minute execution. Run `01M1BVWCJY25G5YTFE88NJ7JST` (project
`bumper-frontend/e2e-test-reporter`) spans `createdAt` 1788178477 →
`completedAt` 1788179507 with 303 test results, but its status was terminal for
most of that window.

Nothing on the read path derives status: the runs-list row renders `run.status`
straight from `RUN_PUBLIC_COLUMNS`, and the live overlay is
`AGGREGATE_SUMMARY_COLUMNS`, which is the same column. Appending results never
writes `runs.status`. The only writers are `completeRun` and the stale-run
watchdog, and the watchdog writes `interrupted`. So the terminal status was a
real `/complete`.

The producer is `gitasf/core-bumper`'s `playwright-tests.yml`: twenty matrix
legs, each running `npx playwright test --project=${{ matrix.project }}`, all
sharing

```yaml
WRIGHTFUL_IDEMPOTENCY_KEY: ${{ github.run_id }}-${{ github.job }}-${{ github.run_attempt }}
```

That override is used verbatim, so the legs deliberately merge into one run —
which is the intent. But Playwright sets `config.shard` only under `--shard`,
and these legs shard by `--project`, so the reporter sent no shard coordinates.
Without them the dashboard has no reason to wait: `completeRun` takes the
non-sharded path and finalizes the run on the first leg's `/complete`. The
1m57s leg decided the run's status while the 16m28s leg was still streaming
into it.

Two further consequences of the same gap:

- Once the run is terminal, a leg whose `openRun` lands after that point hits
  the terminal-duplicate branch, gets `409`, and disables streaming — losing
  every result it holds. This is the same failure mode as the "311 results
  across 20 shards dropped on attempt 2" incident the workflow comments already
  document; the run-attempt discriminator fixed only the rerun half of it.
- `expectedTotalTests` is written by whichever leg opens the run, so the
  progress denominator was one leg's suite size rather than the matrix's.

## What changed

`resolveShardIdentity` in `packages/reporter/src/ci.ts` resolves shard
coordinates from `config.shard` when Playwright is sharding, and otherwise from
`WRIGHTFUL_SHARD_INDEX` (1-based) + `WRIGHTFUL_SHARD_TOTAL`. `onBegin` uses it
in place of the previous inline `config.shard` remap.

The dashboard needs no change: the wire already carries `shard` on open and
complete, and the existing machinery holds the run at `running` until every
shard row exists, merges the worst shard status, sums `expectedTotalTests` per
shard index, and stamps `shardIndex` on each test row.

Design decisions worth keeping:

- **`--shard` wins.** Playwright's own slicing is authoritative; a redundant env
  declaration is reported as ignored rather than silently overriding.
- **Both variables or neither.** A half-declaration would either mislabel a leg
  as a whole run or invent a total the dashboard would then wait on forever, so
  it warns and falls back to the legacy single-run shape.
- **1-based, validated `1 <= index <= total`.** Matches Playwright and the wire.
  GitHub's `strategy.job-index` is 0-based and GitHub expressions have no
  arithmetic operators, so the documented recipe computes the coordinate in the
  step's shell. A leg that passes the raw 0-based index is rejected by the range
  check instead of opening a run whose shard `0` the dashboard would reject at
  `/complete` time.

An env-declared shard also counts as sharded for `resolveCIExecutionPolicy`, so
such a matrix inherits the existing fail-closed rerun handling on GitHub Actions
and the retry-the-pipeline warning on GitLab.

## Files

- `packages/reporter/src/ci.ts` — `resolveShardIdentity`, alongside the file's
  other identity resolvers. It returns `{ shard, warning }`, mirroring how
  `resolveCIExecutionPolicy` hands its warning back rather than writing to
  stderr itself, which keeps both source precedence and validation in one pure
  function and leaves the `onBegin` call site branch-free.
- `packages/reporter/src/index.ts` — `onBegin` resolves shard identity and warns
  on a bad declaration.
- `packages/reporter/src/types.ts` — `ShardInfo` / payload docs no longer claim
  `config.shard` is the only source.
- `packages/reporter/README.md` — "Matrices that shard the suite themselves",
  plus the two new rows in the environment-variable table.
- `.changeset/env-declared-shards.md` — minor release note.

## Consumer change

`gitasf/core-bumper`'s `playwright-tests.yml` declares the coordinates on its
"Run Playwright tests" step:

```yaml
- name: Run Playwright tests
  run: |
    export WRIGHTFUL_SHARD_INDEX=$((JOB_INDEX + 1))
    npx playwright test --project=${{ matrix.project }} --workers=${{ matrix.workers }}
  env:
    JOB_INDEX: ${{ strategy.job-index }}
    WRIGHTFUL_SHARD_TOTAL: ${{ strategy.job-total }}
    # …existing WRIGHTFUL_URL / WRIGHTFUL_TOKEN / WRIGHTFUL_IDEMPOTENCY_KEY
```

Order matters across repos: the dashboard already understands shard payloads, so
the reporter can ship first and the workflow can adopt the variables whenever
the new reporter version is installed. Until then the behaviour is unchanged.

## Verification

- `pnpm --filter @wrightful/reporter exec vitest run src/__tests__/ci.test.ts src/__tests__/reporter-identity.test.ts`
  — `resolveShardIdentity` unit tests: accepted coordinates, `--shard`
  precedence, and a rejection table (missing/empty variable, 0-based index,
  index past the end, fractional, non-numeric, negative, zero total, unexpanded
  CI expression), plus two reporter-level tests asserting the declared shard
  reaches both the open and complete payloads and that a bad declaration omits
  `shard` and warns.
- `pnpm --filter @wrightful/reporter test`
- `pnpm check`
