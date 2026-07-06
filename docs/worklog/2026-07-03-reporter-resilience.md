# 2026-07-03 — Reporter resilience: client-side truncation, SIGTERM pass-through, honest batcher docs (P2-reporter)

## What changed

Hardened the `@wrightful/reporter` against three ways a single oversized value or
a CI cancellation could lose real test results, from the 2026-07-03 review.

### Client-side truncation (prevents 400 / 413 whole-run losses)

- **Title** is a hard-rejected identity field on the dashboard
  (`z.string().max(MAX.TITLE)`), so a long data-driven title 400s the open /
  `/results` call and disables streaming for the whole run. The reporter now
  clamps the **display** title to `MAX_TITLE` in `buildTestDescriptor`. The
  `testId` is hashed from the raw `titlePath` (not the display string), so
  truncating can't change identity — the prefilled queued row and the streamed
  result still match.
- **errorMessage / errorStack / annotation description** are truncated
  server-side, but a multi-megabyte assertion diff can **413 the whole request
  body before it's parsed** (non-retryably). The reporter now clamps these to
  `MAX_MESSAGE` / `MAX_STACK` client-side in `buildPayload` (and the seeder path
  `payload.ts`).
- New `src/limits.ts` holds the caps + a surrogate-pair-safe `truncate` that
  byte-for-byte matches the dashboard's `truncatedText`. The caps MIRROR the
  dashboard's `MAX` (no runtime dep on the dashboard package); `contract.test.ts`
  pins them against the dashboard's exported `MAX` and proves an over-cap payload
  now parses cleanly.

### SIGTERM pass-through (prevents lingering-until-SIGKILL)

`installSignalHandlers` registers a `process.once("SIGTERM")` listener — which
**removes Node's default (immediate exit)** — but Playwright ≤1.61 doesn't watch
SIGTERM, so after the best-effort `/complete` nothing terminated the process; it
lingered until the runner's SIGKILL ~10s later. The handler now **re-raises
SIGTERM** (`process.kill(process.pid, "SIGTERM")`) once its work settles, passing
it through to the default terminate. SIGINT is unchanged (Playwright installs its
own handler and owns the exit code — we must not preempt it). We still never call
`process.exit` (Playwright owns the exit code on SIGINT).

### Honest batcher docs

`batcher.ts` promised a "fallback file" for dropped batches that doesn't exist.
Corrected the docstring: `onFailure` logs a warning and DROPS the batch today,
relying on the dashboard watchdog + the prefilled `queued` rows; a durable
on-disk fallback is noted as a possible future enhancement (not the phantom
promise).

## Details

| File                             | Change                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/limits.ts` (new)            | `MAX_TITLE`/`MAX_MESSAGE`/`MAX_STACK` + `truncate` / `truncateNullable` (surrogate-safe, mirrors dashboard).                                |
| `src/index.ts`                   | Clamp title in `buildTestDescriptor`; clamp error text + annotation descriptions in `buildPayload`; SIGTERM re-raise in the signal handler. |
| `src/payload.ts`                 | Clamp title / error text in the seeder's `buildResult` / `buildAttempt`.                                                                    |
| `src/batcher.ts`                 | Corrected the phantom "fallback file" docstring.                                                                                            |
| `src/__tests__/contract.test.ts` | Pin the caps to the dashboard `MAX`; assert an over-cap title/error is clamped and still parses; unit-test `truncate`.                      |
| `src/__tests__/shutdown.test.ts` | Mock `process.kill` (like `process.exit`) so the re-raise doesn't kill the vitest worker; assert SIGTERM re-raises + SIGINT does not.       |

## Notes / follow-ups

- A durable dropped-batch fallback (persist + re-send next run) is left as a
  future enhancement (the docstring no longer claims it exists).

## Verification

- `pnpm --filter @wrightful/reporter test` — 276 passed (was 274; +2 contract cases).
- `pnpm --filter @wrightful/reporter build` — clean (tsdown typecheck).
- `pnpm check` — 0 lint/type errors.
