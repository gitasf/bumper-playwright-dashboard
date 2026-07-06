# 2026-07-03 — Artifact re-registration refreshes sizeBytes/contentType (P1-2)

## What changed

When an artifact is re-registered under the **same identity tuple**
(`projectId, testResultId, type, name, attempt, role`) with **different bytes** —
a retried `/results` flush whose local trace/screenshot changed between attempts —
`planArtifactRegistration` used to reuse the existing row verbatim. The upload
guard in `storeArtifactUpload` then enforced `contentLength === row.sizeBytes`
against the **stale** size, so the reporter's PUT (carrying the new
Content-Length) 400'd with `lengthMismatch` and the bytes never landed.

Now the reuse path **refreshes** the stored `sizeBytes`/`contentType` to the
re-registered values inside the same atomic batch as the inserts, and meters the
byte delta.

## Why

From the 2026-07-03 architecture review (P1-2). The reviewer's clarification: the
finding's "CI re-run" framing is technically a _same-run idempotent re-register_
(a CI re-run mints fresh testResultIds and never hits the reuse path), which
lowers real-world frequency — but the defect (upload rejected against a stale
size) is real and the fix direction is correct.

## Details

| File                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/artifacts.ts`                     | `ExistingArtifactRow` gains `sizeBytes`/`contentType`; `fetchExistingArtifactRows` selects them. `ArtifactRegistrationPlan` gains `rowsToUpdate` + `updateBytesDelta`. `planArtifactRegistration` emits a refresh (keyed by id, deduped for within-request duplicates) when a **persisted** row's stored size/type differs from the request. `registerArtifacts` widens the early-return to cover updates, gates the quota on the **net positive** new bytes (`Math.max`-guarded so a shrink is never blocked), applies the `UPDATE`s in the batch, and bumps `usageCounters.artifactBytes` by the signed delta (`artifactCount` still counts only inserts). |
| `src/__tests__/artifacts-pipeline.test.ts` | `dbMock` gains `update`; existing reuse fixtures carry `sizeBytes`/`contentType`. New tests: plan refreshes a changed reused row (delta 150); within-request duplicate doesn't double-count the delta; register runs a batch (`UPDATE` + bump) on a size change vs. no batch on pure reuse.                                                                                                                                                                                                                                                                                                                                                                  |

Key invariants preserved: the artifact **identity** tuple is unchanged (the
`artifactIdentity ⇔ artifacts_identity_uq` canary stays green); `sizeBytes` is an
`integer` column so no int8-as-string coercion applies; the update + insert +
usage bump remain in one `runBatch` transaction.

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/artifacts-pipeline.test.ts` — 37 passed (5 new/changed).
- Full dashboard suite green; `pnpm check` — 0 errors.
