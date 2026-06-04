// Plain-data builders for the v3 wire payloads.
//
// The reporter derives its payloads from live Playwright objects (see
// `buildPayload` / `buildTestDescriptor` in index.ts), but the local history
// seeder (apps/dashboard/scripts/seed/generator.mjs) has only synthetic plain
// data and no Playwright runtime — so it used to hand-assemble the v3 shape as
// a third, untested copy of the contract that had already drifted (it omitted
// `projectName` and `workerIndex`, surviving only because the dashboard's Zod
// schemas mark those optional).
//
// These builders concentrate the wire shape both callers must produce: they
// accept the few synthetic fields the seeder owns, fill the structural
// defaults (nullable error fields → null, missing workerIndex → 0), and return
// objects typed against the same `types.ts` interfaces the dashboard's Zod
// schemas mirror. Required fields are validated at runtime so the untyped
// `.mjs` seeder fails loudly at build time rather than producing a payload the
// live server silently degrades or rejects.

import type {
  CompleteRunPayload,
  OpenRunPayload,
  PlannedTestDescriptor,
  TestAttemptPayload,
  TestResultPayload,
} from "./types.js";

/** Run-level metadata for {@link buildOpenRunPayload}. */
export interface RunMeta {
  idempotencyKey: string;
  ciProvider?: string | null;
  ciBuildId?: string | null;
  branch?: string | null;
  environment?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  prNumber?: number | null;
  repo?: string | null;
  actor?: string | null;
  reporterVersion: string;
  playwrightVersion: string;
}

/** Identity fields the seeder supplies per test. */
export interface ResultFields {
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: TestResultPayload["status"];
  durationMs: number;
  retryCount?: number;
  errorMessage?: string | null;
  errorStack?: string | null;
  workerIndex?: number;
  tags?: string[];
  annotations?: Array<{ type: string; description?: string }>;
  /** Optional override; defaults to `testId` (matches the reporter). */
  clientKey?: string;
}

/** Loose per-attempt input — error fields default to `null` when omitted. */
export interface AttemptInput {
  attempt: number;
  status: TestAttemptPayload["status"];
  durationMs: number;
  errorMessage?: string | null;
  errorStack?: string | null;
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `payload builder: \`${field}\` must be a non-empty string`,
    );
  }
}

/**
 * Normalise one attempt to the wire shape, filling `errorMessage` /
 * `errorStack` with `null` when the caller omits them.
 */
export function buildAttempt(input: AttemptInput): TestAttemptPayload {
  return {
    attempt: input.attempt,
    status: input.status,
    durationMs: input.durationMs,
    errorMessage: input.errorMessage ?? null,
    errorStack: input.errorStack ?? null,
  };
}

/**
 * Build a single {@link TestResultPayload} from synthetic identity fields plus
 * its attempts. `projectName` is required (`null` is allowed, `undefined` is
 * not) and `workerIndex` defaults to 0 — the two fields the hand-built seeder
 * dropped. `clientKey` defaults to `testId`, mirroring the reporter.
 */
export function buildResult(
  fields: ResultFields,
  attempts: AttemptInput[],
): TestResultPayload {
  assertString(fields.testId, "testId");
  assertString(fields.title, "title");
  assertString(fields.file, "file");
  if (fields.projectName !== null && typeof fields.projectName !== "string") {
    throw new TypeError(
      "payload builder: `projectName` is required (use null for the default project)",
    );
  }
  if (attempts.length === 0) {
    throw new RangeError(
      "payload builder: a result needs at least one attempt",
    );
  }
  return {
    clientKey: fields.clientKey ?? fields.testId,
    testId: fields.testId,
    title: fields.title,
    file: fields.file,
    projectName: fields.projectName,
    status: fields.status,
    durationMs: fields.durationMs,
    retryCount: fields.retryCount ?? Math.max(0, attempts.length - 1),
    errorMessage: fields.errorMessage ?? null,
    errorStack: fields.errorStack ?? null,
    workerIndex: fields.workerIndex ?? 0,
    tags: fields.tags ?? [],
    annotations: fields.annotations ?? [],
    attempts: attempts.map(buildAttempt),
  };
}

/**
 * Build the open-run payload from run metadata and the planned-test
 * descriptors. `expectedTotalTests` is derived from `planned.length` so it
 * can't drift from the list it summarises.
 */
export function buildOpenRunPayload(
  meta: RunMeta,
  planned: PlannedTestDescriptor[],
): OpenRunPayload {
  assertString(meta.idempotencyKey, "idempotencyKey");
  for (const p of planned) {
    assertString(p.testId, "plannedTest.testId");
    if (p.projectName !== null && typeof p.projectName !== "string") {
      throw new TypeError(
        "payload builder: `plannedTest.projectName` is required (use null for the default project)",
      );
    }
  }
  return {
    idempotencyKey: meta.idempotencyKey,
    run: {
      ciProvider: meta.ciProvider ?? null,
      ciBuildId: meta.ciBuildId ?? null,
      branch: meta.branch ?? null,
      environment: meta.environment ?? null,
      commitSha: meta.commitSha ?? null,
      commitMessage: meta.commitMessage ?? null,
      prNumber: meta.prNumber ?? null,
      repo: meta.repo ?? null,
      actor: meta.actor ?? null,
      reporterVersion: meta.reporterVersion,
      playwrightVersion: meta.playwrightVersion,
      expectedTotalTests: planned.length,
      plannedTests: planned,
    },
  };
}

/** Build the terminal complete-run payload. */
export function buildCompleteRunPayload(
  status: CompleteRunPayload["status"],
  durationMs: number,
): CompleteRunPayload {
  return { status, durationMs };
}
