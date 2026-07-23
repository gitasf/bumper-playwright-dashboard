import { defineFlashSlots } from "@/lib/flash";

/**
 * The flash slots shared by BOTH test-detail pages (`tests/:testId` and
 * `runs/:runId/tests/:testResultId`). Unusually, neither slot is written by a
 * page action — the writers are the session-authed mutation routes
 * (`routes/api/t/…/quarantine.ts` → `quarantineError`, `…/owners.ts` →
 * `ownerError`) that bounce back to the originating page via `redirectTo`.
 * Living in `src/lib/` (not co-located with either page) because two pages
 * read it and two routes write it; all four import this one contract.
 */
export const TEST_DETAIL_FLASH = defineFlashSlots([
  "quarantineError",
  "ownerError",
]);
