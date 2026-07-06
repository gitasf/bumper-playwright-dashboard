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
  /**
   * Playwright shard that ran this test (`config.shard.current`, 1-based), or
   * `null` for a non-sharded run. Unlike the run-level `shard` on open/complete
   * (which is omitted when non-sharded), this is always present so the dashboard
   * can group each test row by its shard. Mirrors the nullable `shardIndex` on
   * `TestResultSchema` in apps/dashboard/src/lib/schemas.ts.
   */
  shardIndex: number | null;
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

/**
 * Playwright shard coordinates from `config.shard` (`{ current, total }`),
 * remapped to `{ index, total }`. Sent on open + complete only for a sharded
 * suite. All shards of one suite share an idempotencyKey (→ one run); `total`
 * tells the dashboard how many shards to wait for before the run may finalize,
 * and `index` (1-based) identifies the completing shard. Omitted on a
 * non-sharded run. Mirrors `ShardSchema` in apps/dashboard/src/lib/schemas.ts.
 */
export interface ShardInfo {
  index: number;
  total: number;
}

export interface OpenRunPayload {
  idempotencyKey: string;
  /** Present only when `config.shard` is set (a sharded suite). */
  shard?: ShardInfo;
  /**
   * The repo's CODEOWNERS file contents (roadmap 2.3). The reporter reads it
   * off disk at `onBegin` (`.github/CODEOWNERS`, then `CODEOWNERS`, then
   * `docs/CODEOWNERS` — first found wins) and includes it here when present;
   * the dashboard's `openRun` upserts it onto the project so test-ownership
   * derivation reflects the latest committed file. Omitted when there is no
   * CODEOWNERS (or it exceeds the size cap), in which case the dashboard leaves
   * any manually-pasted file untouched. Mirrors the optional `codeowners` field
   * on `OpenRunPayloadSchema` in apps/dashboard/src/lib/schemas.ts.
   */
  codeowners?: string;
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
    /**
     * Synthetic-monitoring provenance. Mirrors `RunMetaCommon` in
     * apps/dashboard/src/lib/schemas.ts. Omitted on a normal CI reporter run
     * (the dashboard defaults `origin` to `"ci"` server-side); set to
     * `"synthetic"` with the originating `monitorId` when a scheduled monitor
     * launches this suite in a container. See KEY DESIGN in CLAUDE notes:
     * the container sets `WRIGHTFUL_RUN_ORIGIN`/`WRIGHTFUL_MONITOR_ID` so the
     * opened run is attributable to its monitor execution.
     */
    origin?: "ci" | "synthetic";
    monitorId?: string | null;
  };
}

export interface AppendResultsPayload {
  results: TestResultPayload[];
}

export interface CompleteRunPayload {
  status: "passed" | "failed" | "timedout" | "interrupted";
  durationMs: number;
  /**
   * Present only for a sharded suite (`config.shard` set). Lets the dashboard
   * record this shard's completion and defer the run's terminal status until
   * every shard has reported — see `completeRun` in the dashboard's ingest.
   */
  shard?: ShardInfo;
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

/** One quarantined test as returned by `GET /api/runs/quarantine`. */
export interface QuarantineEntry {
  testId: string;
  mode: "skip" | "soft";
  reason: string | null;
}

/**
 * `GET /api/runs/quarantine` response. The reporter fetches this at `onBegin`
 * and demotes a quarantined hard failure to `skipped` on the wire (v1
 * enforcement — a reporter is observe-only, so it can't skip execution).
 * Mirror of `QuarantineResponseSchema` in apps/dashboard/src/lib/schemas.ts.
 */
export interface QuarantineResponse {
  tests: QuarantineEntry[];
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
   * Wall-clock budget (ms) for the whole onEnd drain — pending result
   * batches plus in-flight artifact uploads — with a slice reserved for the
   * final `/complete` call. On expiry the reporter abandons whatever is
   * still in flight, warns, and completes the run anyway, so a slow
   * dashboard can never hang the suite indefinitely. Defaults to 10 minutes.
   */
  shutdownTimeoutMs?: number;
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
