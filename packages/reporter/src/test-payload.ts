import { relative as relativePath } from "node:path";
import type { TestCase, TestResult } from "@playwright/test/reporter";
import type { PendingTest } from "./accumulator.js";
import {
  joinStdio,
  MAX_MESSAGE,
  MAX_STACK,
  MAX_TITLE,
  truncate,
  truncateNullable,
} from "./limits.js";
import { computeTestId } from "./test-id.js";
import type { TestAttemptPayload, TestResultPayload } from "./types.js";

/**
 * Extract the identifying fields for a test case. Open-run prefill and streamed
 * result payloads share this builder so both phases address the same test row.
 */
export function buildTestDescriptor(
  test: TestCase,
  rootDir: string | null,
): {
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
} {
  const projectName = test.parent.project()?.name ?? "";
  const titlePath = test.titlePath().filter(Boolean);
  const absoluteFile = test.location.file;
  const file = rootDir ? relativePath(rootDir, absoluteFile) : absoluteFile;
  const testId = computeTestId(
    file,
    titlePath,
    projectName,
    test.repeatEachIndex ?? 0,
  );
  return {
    testId,
    // Keep identity derived from the untruncated title path while bounding the
    // display value sent over the wire.
    title: truncate(titlePath.join(" > "), MAX_TITLE),
    file,
    projectName: projectName || null,
  };
}

/** Playwright uses "timedOut"; Wrightful's wire enum uses "timedout". */
function normaliseAttemptStatus(
  status: TestResult["status"],
): TestAttemptPayload["status"] {
  if (status === "timedOut") return "timedout";
  if (status === "failed") return "failed";
  if (status === "passed") return "passed";
  return "skipped";
}

/** Convert a completed accumulated Playwright test into the ingest contract. */
export function buildPayload(
  entry: PendingTest,
  rootDir: string | null = null,
  shardIndex: number | null = null,
): TestResultPayload {
  const { test, results } = entry;
  const descriptor = buildTestDescriptor(test, rootDir);

  const totalDuration = results.reduce(
    (sum, result) => sum + result.duration,
    0,
  );
  const lastResult = results[results.length - 1];
  const failing = results.find(
    (result) => result.status === "failed" || result.status === "timedOut",
  );
  const status = mapOutcome(test, lastResult);
  const errorSource = status === "flaky" ? failing : lastResult;

  const attempts: TestAttemptPayload[] = [...results]
    .sort((a, b) => a.retry - b.retry)
    .map((result) => ({
      attempt: result.retry,
      status: normaliseAttemptStatus(result.status),
      durationMs: Math.round(result.duration),
      errorMessage: truncateNullable(result.errors?.[0]?.message, MAX_MESSAGE),
      errorStack: truncateNullable(result.errors?.[0]?.stack, MAX_STACK),
      stdout: joinStdio(result.stdout, MAX_MESSAGE),
      stderr: joinStdio(result.stderr, MAX_MESSAGE),
    }));

  return {
    clientKey: descriptor.testId,
    testId: descriptor.testId,
    title: descriptor.title,
    file: descriptor.file,
    projectName: descriptor.projectName,
    status,
    durationMs: Math.round(totalDuration),
    retryCount: Math.max(0, results.length - 1),
    errorMessage: truncateNullable(
      errorSource?.errors?.[0]?.message,
      MAX_MESSAGE,
    ),
    errorStack: truncateNullable(errorSource?.errors?.[0]?.stack, MAX_STACK),
    workerIndex:
      lastResult && lastResult.workerIndex >= 0 ? lastResult.workerIndex : 0,
    shardIndex,
    tags: test.tags ?? [],
    annotations: test.annotations.map((annotation) => ({
      type: annotation.type,
      description:
        annotation.description == null
          ? annotation.description
          : truncate(annotation.description, MAX_MESSAGE),
    })),
    attempts,
  };
}

function mapOutcome(
  test: TestCase,
  lastResult: TestResult | undefined,
): "passed" | "failed" | "flaky" | "skipped" | "timedout" {
  switch (test.outcome()) {
    case "expected":
      return "passed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    case "unexpected":
      return lastResult?.status === "timedOut" ? "timedout" : "failed";
    default:
      return "failed";
  }
}
