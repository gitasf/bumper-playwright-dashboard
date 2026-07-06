# 2026-07-03 — Stop serializing the run idempotencyKey into page props (P2-idempotency-leak)

## What changed

Three page loaders returned the **full `runs` row** — including
`idempotencyKey` — into browser-delivered SSR props via a bare
`db.select().from(runs)`:

- run-detail (`runs/[runId]/index.server.ts`)
- test-detail (`runs/[runId]/tests/[testResultId]/index.server.ts`)
- runs-list (`p/[projectSlug]/index.server.ts`) — leaked a **whole page** of keys.

`idempotencyKey` is a **write credential**, not display data: presenting it is
what re-arms an idle terminal run's write window (`reopenRunForWrites` /
`openRun`'s duplicate lookup, `RUN_WRITE_GRACE_SECONDS`). The idle-run
write-closure security rationale explicitly assumes the key "never leaves the
server" — a stolen `runId` alone (which _does_ leak into URLs) can't reopen a
closed run, but a leaked key can. Serializing it into props broke that
assumption; the reporter derives the key from public CI build ids, so it's
guessable-ish but should not be handed out directly.

Now all three loaders project `RUN_PUBLIC_COLUMNS` (a new shared allowlist of
every `runs` column **except** `idempotencyKey`).

## Why

From the 2026-07-03 architecture review (P2-idempotency-leak, confirmed). Column
projection — not salting/hashing the key — is the correct fix: the reopen
mechanism requires the reporter and server to derive the SAME deterministic key,
so salting server-side would break re-stream / re-run recovery and the sharded
merge.

## Details

| File                                      | Change                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/run-columns.ts` (new)            | `RUN_PUBLIC_COLUMNS` — every `runs` column except `idempotencyKey`; a bare `.select()` would also silently re-leak any future secret column, so loaders project this instead.                              |
| the three `*.server.ts` loaders           | `db.select()` → `db.select(RUN_PUBLIC_COLUMNS)`.                                                                                                                                                           |
| `src/__tests__/run-columns.test.ts` (new) | Guards the contract: `idempotencyKey` is never projected, and every OTHER column IS — so a new `runs` column forces a conscious include/exclude here (fails until decided) instead of silently re-leaking. |

Kept every non-secret column so no page component's `run.*` read breaks
(verified by `tsgo --noEmit` — the loaders' `InferProps` flow the narrowed shape
into the page components and the runs-list `useProjectRoom`).

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/run-columns.test.ts` — 2 passed.
- `pnpm --filter @wrightful/dashboard typecheck` — clean (the projection is a safe superset for all three consumers).
- `pnpm check` — 0 errors.
