/**
 * Re-export of API response types for client-side consumption. The actual
 * `routes/api/.../*.get.ts` files live under directories with bracket
 * placeholders (`[teamSlug]`) which TypeScript's module resolver doesn't
 * handle in `import type` paths. This file gives them clean import names.
 */
export type { RunSummaryResponse } from "../../routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/summary";
export type {
  RunResultsResponse,
  LoadRunResultsOpts,
} from "@/lib/runs/results-page";
export type {
  TestPreviewItem,
  TestPreviewResponse,
} from "../../routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/test-preview";
export type { TestResultSummaryResponse } from "../../routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/tests/[testResultId]/summary";
