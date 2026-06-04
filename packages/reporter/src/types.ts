// Wire-format types for the v3 streaming ingest API. Mirrors the Zod
// schemas in apps/dashboard/src/lib/schemas.ts; keep them in
// sync when changing the API contract.

import type { ArtifactType, SnapshotRole } from "./attachments.js";

/**
 * Version of the streaming-ingest protocol this reporter speaks. Sent on every
 * ingest request as the `X-Wrightful-Version` header; the dashboard rejects
 * anything it doesn't support with a 409 (see
 * `apps/dashboard/src/lib/api-auth.ts`'s `SUPPORTED_VERSIONS`). This is the
 * single emit-side source for the version — the dashboard keeps its own
 * accept-set, and `contract.test.ts` asserts the two agree so the literals
 * can't drift silently across the two packages.
 */
export const PROTOCOL_VERSION = 3;

/** Header carrying {@link PROTOCOL_VERSION} on every ingest request. */
export const WRIGHTFUL_VERSION_HEADER = "X-Wrightful-Version";

export interface TestAttemptPayload {
  /** 0 = initial attempt, 1 = first retry, … */
  attempt: number;
  /** Single-attempt outcome; `flaky` lives only on the aggregate. */
  status: "passed" | "failed" | "timedout" | "skipped";
  durationMs: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface TestResultPayload {
  clientKey: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: "passed" | "failed" | "flaky" | "skipped" | "timedout";
  durationMs: number;
  retryCount: number;
  /** Aggregate error (last attempt for failed/timedout, first failing for flaky). */
  errorMessage: string | null;
  errorStack: string | null;
  workerIndex: number;
  tags: string[];
  annotations: Array<{ type: string; description?: string }>;
  /** One entry per Playwright attempt. Always ≥ 1 — Playwright always runs at least once. */
  attempts: TestAttemptPayload[];
}

export interface PlannedTestDescriptor {
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
}

export interface OpenRunPayload {
  idempotencyKey: string;
  run: {
    ciProvider: string | null;
    ciBuildId: string | null;
    branch: string | null;
    environment: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    prNumber: number | null;
    repo: string | null;
    actor: string | null;
    reporterVersion: string;
    playwrightVersion: string;
    expectedTotalTests: number;
    plannedTests: PlannedTestDescriptor[];
  };
}

export interface AppendResultsPayload {
  results: TestResultPayload[];
}

export interface CompleteRunPayload {
  status: "passed" | "failed" | "timedout" | "interrupted";
  durationMs: number;
}

export interface ArtifactUpload {
  artifactId: string;
  uploadUrl: string;
  r2Key: string;
}

// Response-side wire types (server → reporter). Mirror of the
// `*ResponseSchema` Zod schemas in apps/dashboard/src/lib/schemas.ts; the
// reporter reads only these fields off each response (see client.ts). The
// contract test parses values of these shapes through the dashboard schemas so
// a rename on either side fails the build.

export interface OpenRunResponse {
  runId: string;
  runUrl?: string;
}

export interface ResultMapping {
  clientKey: string;
  testResultId: string;
}

export interface AppendResultsResponse {
  results: ResultMapping[];
}

export interface RegisterArtifactsResponse {
  uploads: ArtifactUpload[];
}

export interface ArtifactRegistration {
  testResultId: string;
  type: ArtifactType;
  name: string;
  contentType: string;
  sizeBytes: number;
  /** Playwright attempt index (0 = initial, 1 = first retry, …). */
  attempt: number;
  /**
   * For `type: "visual"` artifacts: which side of the snapshot triple this
   * file is. Required when `type === "visual"`, ignored otherwise.
   */
  role?: SnapshotRole;
  /**
   * For `type: "visual"` artifacts: the shared base name that groups the
   * expected/actual/diff triple within a single test attempt (e.g.
   * `hero-chromium-linux`). Required when `type === "visual"`.
   */
  snapshotName?: string;
}

export type ArtifactMode = "all" | "failed" | "none";

export interface ReporterOptions {
  /** Dashboard base URL, e.g. https://wrightful.example.com */
  url?: string;
  /** Bearer API key. Falls back to env WRIGHTFUL_TOKEN. */
  token?: string;
  /** Max results per flush. Defaults to 20. */
  batchSize?: number;
  /** Max delay between flushes (ms). Defaults to 500. */
  flushIntervalMs?: number;
  /** Environment tag for the run. */
  environment?: string;
  /**
   * Which tests' attachments to upload. `failed` (default): only upload
   * for unexpected failures + flaky retries. `all`: upload every test's
   * attachments. `none`: skip artifact uploads entirely.
   */
  artifacts?: ArtifactMode;
  /**
   * Post a sticky summary comment to the GitHub PR when the run completes.
   *
   * Requires GitHub Actions context (`GITHUB_ACTIONS=true`), a PR-triggered
   * workflow (`GITHUB_REF=refs/pull/N/merge` so `prNumber` is set), `repo`
   * detected, and a `GITHUB_TOKEN` (or `WRIGHTFUL_GITHUB_TOKEN`) in env.
   * Defaults to false. Comment is upserted via a hidden marker so re-runs
   * of the same workflow update the existing comment.
   */
  postPrComment?: boolean;
}
