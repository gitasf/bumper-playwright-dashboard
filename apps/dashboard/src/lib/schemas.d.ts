import { z } from "zod";
/**
 * Wire-protocol schemas for the streaming-ingest API (v3).
 *
 * Mirror of `@wrightful/reporter`'s TS interfaces. Keep this file in sync
 * with that package whenever the reporter contract changes.
 *
 * Every string and array carries an upper bound. The reporter is a trusted
 * client, but an API key is a bearer credential — a stolen or buggy one must
 * not be able to post unbounded payloads (million-entry arrays, multi-MB error
 * stacks) that blow D1 row sizes or Worker memory before the param-chunker
 * runs.
 *
 * Two strategies:
 *   - Free-form diagnostic text (error messages/stacks, commit message,
 *     annotation descriptions) is TRUNCATED, not rejected. A Playwright
 *     assertion diff on a large object routinely exceeds tens of KB; rejecting
 *     would fail the whole batch with a non-retryable 4xx and the reporter
 *     would silently drop every result in it. Storing a truncated message is
 *     strictly better than losing the failure it describes.
 *   - Identity / structural fields (ids, titles, files, tags, names, versions)
 *     and array lengths keep hard `.max()` caps with generous limits — oversize
 *     there signals a malformed/abusive payload, not a legitimate large test.
 */
/**
 * Header the reporter stamps the protocol version onto (mirror of
 * `WRIGHTFUL_VERSION_HEADER` in `@wrightful/reporter`). Lives here so the
 * version contract sits next to the wire-shape contract in the one module the
 * reporter's cross-package canary already imports.
 */
export declare const WRIGHTFUL_VERSION_HEADER = "X-Wrightful-Version";
/**
 * Versions of the streaming-ingest protocol this dashboard accepts.
 * `api-auth.ts` reads this set to 409 unsupported reporters; the reporter's
 * emit-side `PROTOCOL_VERSION` must be a member, which
 * `packages/reporter/src/__tests__/contract.test.ts` asserts so the two
 * independently-maintained literals can't drift silently across the packages.
 */
export declare const SUPPORTED_VERSIONS: Set<string>;
export declare const MAX: {
  readonly ID: 1024;
  readonly TITLE: 2048;
  readonly FILE: 1024;
  readonly NAME: 1024;
  readonly SHORT: 256;
  readonly TAG: 256;
  readonly VERSION: 128;
  readonly MESSAGE: 65536;
  readonly STACK: 131072;
  readonly COMMIT_MSG: 16384;
  readonly CODEOWNERS: 65536;
};
export declare const MAX_RESULTS_PER_BATCH = 5000;
export declare const MAX_PLANNED_TESTS = 100000;
export declare const TestAttemptSchema: z.ZodObject<
  {
    attempt: z.ZodNumber;
    status: z.ZodEnum<{
      failed: "failed";
      passed: "passed";
      skipped: "skipped";
      timedout: "timedout";
    }>;
    durationMs: z.ZodNumber;
    errorMessage: z.ZodOptional<
      z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
    >;
    errorStack: z.ZodOptional<
      z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
    >;
    stdout: z.ZodOptional<
      z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
    >;
    stderr: z.ZodOptional<
      z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
    >;
  },
  z.core.$strip
>;
export type TestAttemptInput = z.infer<typeof TestAttemptSchema>;
declare const TestResultSchema: z.ZodObject<
  {
    clientKey: z.ZodOptional<z.ZodString>;
    testId: z.ZodString;
    title: z.ZodString;
    file: z.ZodString;
    projectName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodEnum<{
      failed: "failed";
      flaky: "flaky";
      passed: "passed";
      skipped: "skipped";
      timedout: "timedout";
    }>;
    durationMs: z.ZodNumber;
    retryCount: z.ZodDefault<z.ZodNumber>;
    errorMessage: z.ZodOptional<
      z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
    >;
    errorStack: z.ZodOptional<
      z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
    >;
    workerIndex: z.ZodOptional<z.ZodNumber>;
    shardIndex: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    annotations: z.ZodDefault<
      z.ZodArray<
        z.ZodObject<
          {
            type: z.ZodString;
            description: z.ZodOptional<
              z.ZodNullable<
                z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
              >
            >;
          },
          z.core.$strip
        >
      >
    >;
    attempts: z.ZodArray<
      z.ZodObject<
        {
          attempt: z.ZodNumber;
          status: z.ZodEnum<{
            failed: "failed";
            passed: "passed";
            skipped: "skipped";
            timedout: "timedout";
          }>;
          durationMs: z.ZodNumber;
          errorMessage: z.ZodOptional<
            z.ZodNullable<
              z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
            >
          >;
          errorStack: z.ZodOptional<
            z.ZodNullable<
              z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
            >
          >;
          stdout: z.ZodOptional<
            z.ZodNullable<
              z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
            >
          >;
          stderr: z.ZodOptional<
            z.ZodNullable<
              z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
            >
          >;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
export type TestResultInput = z.infer<typeof TestResultSchema>;
declare const PlannedTestSchema: z.ZodObject<
  {
    testId: z.ZodString;
    title: z.ZodString;
    file: z.ZodString;
    projectName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  },
  z.core.$strip
>;
export type PlannedTestInput = z.infer<typeof PlannedTestSchema>;
export declare const OpenRunPayloadSchema: z.ZodObject<
  {
    idempotencyKey: z.ZodString;
    run: z.ZodObject<
      {
        ciProvider: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        ciBuildId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        environment: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        commitSha: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        commitMessage: z.ZodOptional<
          z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>
        >;
        prNumber: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        repo: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        actor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reporterVersion: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        playwrightVersion: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        expectedTotalTests: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        plannedTests: z.ZodDefault<
          z.ZodArray<
            z.ZodObject<
              {
                testId: z.ZodString;
                title: z.ZodString;
                file: z.ZodString;
                projectName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
              },
              z.core.$strip
            >
          >
        >;
        origin: z.ZodOptional<
          z.ZodEnum<{
            ci: "ci";
            synthetic: "synthetic";
          }>
        >;
        monitorId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      },
      z.core.$strip
    >;
    codeowners: z.ZodOptional<z.ZodString>;
    shard: z.ZodOptional<
      z.ZodObject<
        {
          index: z.ZodNumber;
          total: z.ZodNumber;
        },
        z.core.$strip
      >
    >;
    createdAt: z.ZodOptional<z.ZodNumber>;
  },
  z.core.$strip
>;
export type OpenRunPayload = z.infer<typeof OpenRunPayloadSchema>;
export declare const AppendResultsPayloadSchema: z.ZodObject<
  {
    results: z.ZodArray<
      z.ZodObject<
        {
          clientKey: z.ZodOptional<z.ZodString>;
          testId: z.ZodString;
          title: z.ZodString;
          file: z.ZodString;
          projectName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
          status: z.ZodEnum<{
            failed: "failed";
            flaky: "flaky";
            passed: "passed";
            skipped: "skipped";
            timedout: "timedout";
          }>;
          durationMs: z.ZodNumber;
          retryCount: z.ZodDefault<z.ZodNumber>;
          errorMessage: z.ZodOptional<
            z.ZodNullable<
              z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
            >
          >;
          errorStack: z.ZodOptional<
            z.ZodNullable<
              z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
            >
          >;
          workerIndex: z.ZodOptional<z.ZodNumber>;
          shardIndex: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
          tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
          annotations: z.ZodDefault<
            z.ZodArray<
              z.ZodObject<
                {
                  type: z.ZodString;
                  description: z.ZodOptional<
                    z.ZodNullable<
                      z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
                    >
                  >;
                },
                z.core.$strip
              >
            >
          >;
          attempts: z.ZodArray<
            z.ZodObject<
              {
                attempt: z.ZodNumber;
                status: z.ZodEnum<{
                  failed: "failed";
                  passed: "passed";
                  skipped: "skipped";
                  timedout: "timedout";
                }>;
                durationMs: z.ZodNumber;
                errorMessage: z.ZodOptional<
                  z.ZodNullable<
                    z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
                  >
                >;
                errorStack: z.ZodOptional<
                  z.ZodNullable<
                    z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
                  >
                >;
                stdout: z.ZodOptional<
                  z.ZodNullable<
                    z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
                  >
                >;
                stderr: z.ZodOptional<
                  z.ZodNullable<
                    z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>
                  >
                >;
              },
              z.core.$strip
            >
          >;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
export type AppendResultsPayload = z.infer<typeof AppendResultsPayloadSchema>;
/**
 * A run's terminal statuses (the `status` values `completeRun` accepts and
 * that a finished run can settle into). Canonical list — derive, don't
 * restate: `CompleteRunPayloadSchema.status` below builds its `z.enum` from
 * this, and `@/lib/github-pr-comment` reuses it (as `TERMINAL_RUN_STATUSES`)
 * to select the previous terminal run as a PR-comment diff baseline.
 */
export declare const TERMINAL_RUN_STATUSES: readonly [
  "passed",
  "failed",
  "timedout",
  "interrupted",
];
export declare const CompleteRunPayloadSchema: z.ZodObject<
  {
    status: z.ZodEnum<{
      failed: "failed";
      interrupted: "interrupted";
      passed: "passed";
      timedout: "timedout";
    }>;
    durationMs: z.ZodNumber;
    shard: z.ZodOptional<
      z.ZodObject<
        {
          index: z.ZodNumber;
          total: z.ZodNumber;
        },
        z.core.$strip
      >
    >;
    completedAt: z.ZodOptional<z.ZodNumber>;
  },
  z.core.$strip
>;
export type CompleteRunPayload = z.infer<typeof CompleteRunPayloadSchema>;
export declare const RegisterArtifactsPayloadSchema: z.ZodObject<
  {
    runId: z.ZodString;
    artifacts: z.ZodArray<
      z.ZodPipe<
        z.ZodObject<
          {
            testResultId: z.ZodString;
            type: z.ZodEnum<{
              other: "other";
              screenshot: "screenshot";
              trace: "trace";
              video: "video";
              visual: "visual";
            }>;
            name: z.ZodString;
            contentType: z.ZodString;
            sizeBytes: z.ZodNumber;
            attempt: z.ZodDefault<z.ZodNumber>;
            role: z.ZodOptional<
              z.ZodEnum<{
                actual: "actual";
                diff: "diff";
                expected: "expected";
              }>
            >;
            snapshotName: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >,
        z.ZodTransform<
          {
            testResultId: string;
            type: "other" | "screenshot" | "trace" | "video" | "visual";
            name: string;
            contentType: string;
            sizeBytes: number;
            attempt: number;
            role?: "actual" | "diff" | "expected" | undefined;
            snapshotName?: string | undefined;
          },
          {
            testResultId: string;
            type: "other" | "screenshot" | "trace" | "video" | "visual";
            name: string;
            contentType: string;
            sizeBytes: number;
            attempt: number;
            role?: "actual" | "diff" | "expected" | undefined;
            snapshotName?: string | undefined;
          }
        >
      >
    >;
  },
  z.core.$strip
>;
export type RegisterArtifactsPayload = z.infer<
  typeof RegisterArtifactsPayloadSchema
>;
/**
 * Response-side wire schemas (server → reporter).
 *
 * The reporter parses these responses with inline `as` casts (see
 * `StreamClient.openRun` / `appendResults` / `registerArtifacts` in
 * `@wrightful/reporter`'s `client.ts`). Those casts are unchecked, so a field
 * rename on either side would silently break the artifact-registration step
 * that hangs off the `clientKey → testResultId` mapping. These schemas describe
 * exactly what the reporter reads off each response and exist so
 * `contract.test.ts` can guard the response contract the same way it guards the
 * request payloads.
 *
 * They describe the *reporter-consumed* fields only — handlers may include
 * extra fields (e.g. `duplicate`, `maxBytes` on error paths) that the reporter
 * ignores; `.passthrough()` keeps those tolerated rather than treated as drift.
 */
export declare const OpenRunResponseSchema: z.ZodObject<
  {
    runId: z.ZodString;
    runUrl: z.ZodOptional<z.ZodString>;
  },
  z.core.$loose
>;
export type OpenRunResponse = z.infer<typeof OpenRunResponseSchema>;
export declare const ResultMappingSchema: z.ZodObject<
  {
    clientKey: z.ZodString;
    testResultId: z.ZodString;
  },
  z.core.$strip
>;
export type ResultMapping = z.infer<typeof ResultMappingSchema>;
export declare const AppendResultsResponseSchema: z.ZodObject<
  {
    results: z.ZodArray<
      z.ZodObject<
        {
          clientKey: z.ZodString;
          testResultId: z.ZodString;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$loose
>;
export type AppendResultsResponse = z.infer<typeof AppendResultsResponseSchema>;
export declare const ArtifactUploadSchema: z.ZodObject<
  {
    artifactId: z.ZodString;
    uploadUrl: z.ZodString;
    r2Key: z.ZodString;
  },
  z.core.$strip
>;
export type ArtifactUpload = z.infer<typeof ArtifactUploadSchema>;
export declare const RegisterArtifactsResponseSchema: z.ZodObject<
  {
    uploads: z.ZodArray<
      z.ZodObject<
        {
          artifactId: z.ZodString;
          uploadUrl: z.ZodString;
          r2Key: z.ZodString;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$loose
>;
export type RegisterArtifactsResponse = z.infer<
  typeof RegisterArtifactsResponseSchema
>;
/**
 * `GET /api/runs/quarantine` response (server → reporter). The reporter pulls
 * the project's flaky-test quarantine list at `onBegin` and demotes a
 * quarantined hard failure to `skipped` on the wire. Reporter-consumed fields
 * only; `.passthrough()` tolerates any extra the handler adds. Mirrors
 * `QuarantineResponse` in `@wrightful/reporter`'s `types.ts`.
 */
export declare const QuarantineEntrySchema: z.ZodObject<
  {
    testId: z.ZodString;
    mode: z.ZodEnum<{
      skip: "skip";
      soft: "soft";
    }>;
    reason: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
>;
export type QuarantineEntryWire = z.infer<typeof QuarantineEntrySchema>;
export declare const QuarantineResponseSchema: z.ZodObject<
  {
    tests: z.ZodArray<
      z.ZodObject<
        {
          testId: z.ZodString;
          mode: z.ZodEnum<{
            skip: "skip";
            soft: "soft";
          }>;
          reason: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$loose
>;
export type QuarantineResponse = z.infer<typeof QuarantineResponseSchema>;
export {};
