import { z } from "zod";
// Relative (not `@/`) so the reporter's wire-contract test can import this
// module cross-package without the dashboard's path alias.
import { isSafeContentType } from "./content-types";

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
export const WRIGHTFUL_VERSION_HEADER = "X-Wrightful-Version";

/**
 * Versions of the streaming-ingest protocol this dashboard accepts.
 * `api-auth.ts` reads this set to 409 unsupported reporters; the reporter's
 * emit-side `PROTOCOL_VERSION` must be a member, which
 * `packages/reporter/src/__tests__/contract.test.ts` asserts so the two
 * independently-maintained literals can't drift silently across the packages.
 */
export const SUPPORTED_VERSIONS = new Set(["3"]);

// String length caps (characters).
const MAX = {
  ID: 1024,
  TITLE: 2048,
  FILE: 1024,
  NAME: 1024,
  SHORT: 256,
  TAG: 256,
  VERSION: 128,
  MESSAGE: 65536,
  STACK: 131072,
  COMMIT_MSG: 16384,
} as const;

// Array caps.
const MAX_ATTEMPTS = 100;
const MAX_TAGS = 200;
const MAX_ANNOTATIONS = 200;
const MAX_RESULTS_PER_BATCH = 5000;
const MAX_PLANNED_TESTS = 100_000;
const MAX_ARTIFACTS_PER_REQUEST = 2000;

/**
 * Free-form diagnostic text: truncate to `max` rather than reject, so an
 * oversized error message/stack never causes the reporter's whole batch to be
 * dropped. Lossy by design — a truncated stack beats a lost test result.
 */
const truncatedText = (max: number) =>
  z
    .string()
    .transform((s) => {
      if (s.length <= max) return s;
      // Don't split a surrogate pair at the cut: a lone high surrogate is
      // ill-formed UTF-16/UTF-8 and breaks JSON serialization to the client.
      const lastKept = s.charCodeAt(max - 1);
      const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? max - 1 : max;
      return s.slice(0, end);
    })
    .nullable()
    .optional();

export const TestAttemptSchema = z.object({
  attempt: z.number().int().min(0),
  status: z.enum(["passed", "failed", "timedout", "skipped"]),
  durationMs: z.number().int().min(0),
  errorMessage: truncatedText(MAX.MESSAGE),
  errorStack: truncatedText(MAX.STACK),
});

export type TestAttemptInput = z.infer<typeof TestAttemptSchema>;

const TestResultSchema = z.object({
  clientKey: z.string().min(1).max(MAX.SHORT).optional(),
  testId: z.string().min(1).max(MAX.ID),
  title: z.string().min(1).max(MAX.TITLE),
  file: z.string().min(1).max(MAX.FILE),
  projectName: z.string().max(MAX.NAME).nullable().optional(),
  status: z.enum(["passed", "failed", "flaky", "skipped", "timedout"]),
  durationMs: z.number().int().min(0),
  retryCount: z.number().int().min(0).default(0),
  errorMessage: truncatedText(MAX.MESSAGE),
  errorStack: truncatedText(MAX.STACK),
  workerIndex: z.number().int().min(0).optional(),
  tags: z.array(z.string().min(1).max(MAX.TAG)).max(MAX_TAGS).default([]),
  annotations: z
    .array(
      z.object({
        type: z.string().min(1).max(MAX.SHORT),
        description: truncatedText(MAX.MESSAGE),
      }),
    )
    .max(MAX_ANNOTATIONS)
    .default([]),
  attempts: z.array(TestAttemptSchema).min(1).max(MAX_ATTEMPTS),
});

export type TestResultInput = z.infer<typeof TestResultSchema>;

const PlannedTestSchema = z.object({
  testId: z.string().min(1).max(MAX.ID),
  title: z.string().min(1).max(MAX.TITLE),
  file: z.string().min(1).max(MAX.FILE),
  projectName: z.string().max(MAX.NAME).nullable().optional(),
});

export type PlannedTestInput = z.infer<typeof PlannedTestSchema>;

const RunMetaCommon = {
  ciProvider: z.string().max(MAX.SHORT).nullable().optional(),
  ciBuildId: z.string().max(MAX.SHORT).nullable().optional(),
  branch: z.string().max(MAX.NAME).nullable().optional(),
  environment: z.string().max(MAX.NAME).nullable().optional(),
  commitSha: z.string().max(MAX.SHORT).nullable().optional(),
  commitMessage: truncatedText(MAX.COMMIT_MSG),
  prNumber: z.number().int().nullable().optional(),
  repo: z.string().max(MAX.NAME).nullable().optional(),
  actor: z.string().max(MAX.NAME).nullable().optional(),
  reporterVersion: z.string().max(MAX.VERSION).nullable().optional(),
  playwrightVersion: z.string().max(MAX.VERSION).nullable().optional(),
  expectedTotalTests: z.number().int().min(0).nullable().optional(),
  plannedTests: z.array(PlannedTestSchema).max(MAX_PLANNED_TESTS).default([]),
  /**
   * Synthetic-monitoring provenance. `origin` defaults to `"ci"` server-side
   * when absent (a normal reporter run); `"synthetic"` marks a run produced by
   * a scheduled monitor, in which case `monitorId` carries the originating
   * `monitors.id`. Both optional so the standard CI reporter omits them.
   */
  origin: z.enum(["ci", "synthetic"]).optional(),
  monitorId: z.string().max(MAX.ID).nullable().optional(),
};

// Unix seconds. Optional and only honored in dev — production handlers
// reject it so a compromised API key can't fabricate historical rows. Used
// by the local seed script to backdate synthetic runs.
const BackdateSeconds = z.number().int().min(0).optional();

export const OpenRunPayloadSchema = z.object({
  idempotencyKey: z.string().min(1).max(MAX.ID),
  run: z.object(RunMetaCommon),
  createdAt: BackdateSeconds,
});
export type OpenRunPayload = z.infer<typeof OpenRunPayloadSchema>;

export const AppendResultsPayloadSchema = z.object({
  results: z.array(TestResultSchema).min(1).max(MAX_RESULTS_PER_BATCH),
});
export type AppendResultsPayload = z.infer<typeof AppendResultsPayloadSchema>;

export const CompleteRunPayloadSchema = z.object({
  status: z.enum(["passed", "failed", "timedout", "interrupted"]),
  durationMs: z.number().int().min(0),
  completedAt: BackdateSeconds,
});
export type CompleteRunPayload = z.infer<typeof CompleteRunPayloadSchema>;

const ArtifactRequestSchema = z
  .object({
    testResultId: z.string().min(1).max(MAX.ID),
    type: z.enum(["trace", "screenshot", "video", "visual", "other"]),
    name: z.string().min(1).max(MAX.NAME),
    // `contentType` is reflected back as a response header on the artifact
    // download endpoint, which is served from the dashboard origin. Anything
    // outside the safe set could be served as `text/html` (or SVG with
    // embedded script) and execute in the dashboard origin — see
    // `src/lib/content-types.ts`.
    contentType: z.string().min(1).max(MAX.SHORT).refine(isSafeContentType, {
      message: "Unsupported contentType",
    }),
    sizeBytes: z.number().int().min(0),
    attempt: z.number().int().min(0).default(0),
    role: z.enum(["expected", "actual", "diff"]).optional(),
    snapshotName: z.string().min(1).max(255).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.type === "visual") {
      if (!a.role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["role"],
          message: "role is required when type is 'visual'",
        });
      }
      if (!a.snapshotName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["snapshotName"],
          message: "snapshotName is required when type is 'visual'",
        });
      }
    }
  });

export const RegisterArtifactsPayloadSchema = z.object({
  runId: z.string().min(1).max(MAX.ID),
  artifacts: z
    .array(ArtifactRequestSchema)
    .min(1)
    .max(MAX_ARTIFACTS_PER_REQUEST),
});

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
export const OpenRunResponseSchema = z
  .object({
    runId: z.string().min(1),
    runUrl: z.string().min(1).optional(),
  })
  .passthrough();
export type OpenRunResponse = z.infer<typeof OpenRunResponseSchema>;

export const ResultMappingSchema = z.object({
  clientKey: z.string().min(1),
  testResultId: z.string().min(1),
});
export type ResultMapping = z.infer<typeof ResultMappingSchema>;

export const AppendResultsResponseSchema = z
  .object({
    results: z.array(ResultMappingSchema),
  })
  .passthrough();
export type AppendResultsResponse = z.infer<typeof AppendResultsResponseSchema>;

export const ArtifactUploadSchema = z.object({
  artifactId: z.string().min(1),
  uploadUrl: z.string().min(1),
  r2Key: z.string().min(1),
});
export type ArtifactUpload = z.infer<typeof ArtifactUploadSchema>;

export const RegisterArtifactsResponseSchema = z
  .object({
    uploads: z.array(ArtifactUploadSchema),
  })
  .passthrough();
export type RegisterArtifactsResponse = z.infer<
  typeof RegisterArtifactsResponseSchema
>;
