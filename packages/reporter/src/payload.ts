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

import {
  MAX_MESSAGE,
  MAX_STACK,
  MAX_TITLE,
  truncate,
  truncateNullable,
} from "./limits.js";
import type {
  CompleteRunPayload,
  OpenRunPayload,
  PlannedTestDescriptor,
  ShardInfo,
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
  /**
   * Synthetic-monitoring provenance — threaded straight onto the open-run
   * `run` object. Omitted → the dashboard defaults `origin` to `"ci"`. A
   * containerized monitor run passes `origin: "synthetic"` + the originating
   * `monitorId` so the run links back to its `monitors.id`. Mirrors
   * `RunMetaCommon` in apps/dashboard/src/lib/schemas.ts.
   */
  origin?: "ci" | "synthetic";
  monitorId?: string | null;
  /**
   * Playwright shard coordinates for a sharded suite. When set, rides at the
   * TOP LEVEL of the open payload (mirrors the reporter), so the dashboard
   * records `expectedShards` and defers finalize. Omitted → non-sharded.
   */
  shard?: ShardInfo;
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
  /** 1-based shard that ran this test; defaults to `null` (non-sharded). */
  shardIndex?: number | null;
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
  /**
   * Captured attempt stdout/stderr. The live reporter joins the Playwright
   * `TestResult` chunks; the seeder rarely sets these, so both default to
   * `null` (still emitted, mirroring the error fields).
   */
  stdout?: string | null;
  stderr?: string | null;
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
 * `errorStack` / `stdout` / `stderr` with `null` when the caller omits them.
 */
export function buildAttempt(input: AttemptInput): TestAttemptPayload {
  return {
    attempt: input.attempt,
    status: input.status,
    durationMs: input.durationMs,
    // Clamp free-form text to the dashboard caps (parity with the live reporter
    // path) so an oversized seeded stack can't 413 the batch.
    errorMessage: truncateNullable(input.errorMessage, MAX_MESSAGE),
    errorStack: truncateNullable(input.errorStack, MAX_STACK),
    // Captured logs share the MAX_MESSAGE cap; the live path joins Playwright's
    // chunks (see index.ts buildPayload) — here they're already strings/null.
    stdout: truncateNullable(input.stdout, MAX_MESSAGE),
    stderr: truncateNullable(input.stderr, MAX_MESSAGE),
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
    title: truncate(fields.title, MAX_TITLE),
    file: fields.file,
    projectName: fields.projectName,
    status: fields.status,
    durationMs: fields.durationMs,
    retryCount: fields.retryCount ?? Math.max(0, attempts.length - 1),
    errorMessage: truncateNullable(fields.errorMessage, MAX_MESSAGE),
    errorStack: truncateNullable(fields.errorStack, MAX_STACK),
    workerIndex: fields.workerIndex ?? 0,
    shardIndex: fields.shardIndex ?? null,
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
    // Top-level shard (not inside `run`) mirrors the reporter's open payload.
    ...(meta.shard ? { shard: meta.shard } : {}),
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
      // Provenance fields are spread conditionally: a normal CI run omits them
      // entirely (the dashboard defaults `origin` to "ci") so the standard
      // open-run shape is unchanged; a synthetic monitor run carries both.
      ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
      ...(meta.monitorId !== undefined ? { monitorId: meta.monitorId } : {}),
    },
  };
}

/**
 * Build the terminal complete-run payload. Pass `shard` for a sharded suite so
 * the dashboard records this shard's completion (one `runShards` row) and
 * defers the run's terminal status until every shard has reported.
 */
export function buildCompleteRunPayload(
  status: CompleteRunPayload["status"],
  durationMs: number,
  shard?: ShardInfo,
): CompleteRunPayload {
  return { status, durationMs, ...(shard ? { shard } : {}) };
}
