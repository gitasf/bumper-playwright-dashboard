import { realpath } from "node:fs/promises";
import { relative as relativePath } from "node:path";
import type {
  Reporter,
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  classifyAttachment,
  parseSnapshotAttachment,
  safeResolvedPath,
  safeSize,
  type ArtifactType,
  type SnapshotRole,
} from "./attachments.js";
import {
  TestAccumulator,
  isTestDone,
  type PendingTest,
} from "./accumulator.js";
import { ArtifactUploader } from "./artifact-uploader.js";
import { Batcher } from "./batcher.js";
import { detectCI, generateIdempotencyKey, type CIInfo } from "./ci.js";
import { AuthError, StreamClient } from "./client.js";
import {
  postPrComment,
  shouldPostPrComment,
  type RunSummary,
} from "./pr-comment.js";
import { computeTestId } from "./test-id.js";
import type {
  ArtifactMode,
  ReporterOptions,
  TestAttemptPayload,
  TestResultPayload,
} from "./types.js";

// Replaced at build time by tsdown's `define` with the literal package.json
// version. The `typeof` guard keeps Vitest + ts-node (which run source) happy.
declare const __REPORTER_VERSION__: string;
const REPORTER_VERSION =
  typeof __REPORTER_VERSION__ === "string" ? __REPORTER_VERSION__ : "0.0.0-dev";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_ARTIFACT_MODE: ArtifactMode = "failed";
const ARTIFACT_UPLOAD_CONCURRENCY = 4;
// Best-effort `/complete` attempt fired from a signal handler. Kept short so
// we don't hold the process open past when the OS would SIGKILL anyway.
const SHUTDOWN_COMPLETE_TIMEOUT_MS = 3_000;

function warn(message: string): void {
  // Reporter must never fail the suite. All user-facing messaging goes to
  // stderr, prefixed so Playwright's default reporter output stays readable.
  process.stderr.write(`[wrightful] ${message}\n`);
}

export interface PreparedArtifact {
  type: ArtifactType;
  name: string;
  contentType: string;
  sizeBytes: number;
  localPath: string;
  attempt: number;
  role?: SnapshotRole;
  snapshotName?: string;
}

// `isTestDone` and the `PendingTest` shape are owned by ./accumulator and
// re-exported here so existing import sites (tests, downstream) stay stable.
export { isTestDone, type PendingTest };

// The streaming ingest client is part of the package's public surface so
// out-of-process callers (e.g. the local history seeder in
// apps/dashboard/scripts) can drive the same open → append → complete pipeline
// the reporter uses — with the same retry / Retry-After / timeout / version-
// header behaviour — instead of hand-rolling a second, untested HTTP client.
export { AuthError, StreamClient } from "./client.js";

// Plain-data v3 payload builders. The reporter derives payloads from live
// Playwright objects via `buildPayload` / `buildTestDescriptor`; the local
// history seeder has only synthetic plain data, so it feeds these builders the
// few fields it owns and gets back the same wire shape — concentrating the v3
// contract instead of hand-assembling a third, drift-prone copy.
export {
  buildAttempt,
  buildCompleteRunPayload,
  buildOpenRunPayload,
  buildResult,
  type AttemptInput,
  type ResultFields,
  type RunMeta,
} from "./payload.js";

/**
 * Promote tentative snapshot images to `type: "visual"` only when all three
 * roles (expected, actual, diff) are present in the same `(attempt,
 * snapshotName)` group. A lone or pair of snapshot-named images falls back
 * to a plain `screenshot` with role/snapshotName cleared — that's the
 * defense against a passing test that does
 * `testInfo.attach('foo-actual.png', …)` with no sibling diff/expected.
 */
export function promoteSnapshotTriples(
  artifacts: PreparedArtifact[],
): PreparedArtifact[] {
  const counts = new Map<string, Set<SnapshotRole>>();
  for (const a of artifacts) {
    if (!a.snapshotName || !a.role) continue;
    const key = `${a.attempt}::${a.snapshotName}`;
    let set = counts.get(key);
    if (!set) {
      set = new Set<SnapshotRole>();
      counts.set(key, set);
    }
    set.add(a.role);
  }
  return artifacts.map((a) => {
    if (!a.snapshotName || !a.role) return a;
    const key = `${a.attempt}::${a.snapshotName}`;
    const roles = counts.get(key);
    const complete =
      roles?.has("expected") && roles.has("actual") && roles.has("diff");
    if (complete) {
      return { ...a, type: "visual" as const };
    }
    return {
      ...a,
      type: "screenshot" as const,
      role: undefined,
      snapshotName: undefined,
    };
  });
}

interface EnqueuedTest {
  payload: TestResultPayload;
  artifacts: PreparedArtifact[];
}

/**
 * Playwright reporter that streams one row per test to a Wrightful
 * dashboard as each test reaches its final outcome. Retried tests are
 * aggregated into a single `flaky` row.
 *
 * Configure in playwright.config.ts:
 *
 *   reporter: [['@wrightful/reporter', { url, token, environment }]]
 *
 * Credentials can also come from env: `WRIGHTFUL_URL`, `WRIGHTFUL_TOKEN`.
 *
 * Failure mode semantics:
 *   - Network errors during streaming are logged; the dashboard may show
 *     partial data. Run the suite again and the deterministic idempotency
 *     key will recover the same run.
 *   - If `onEnd` never fires (CI killed with SIGKILL) the run stays at
 *     `status='running'` until the dashboard's cron watchdog sweeps it
 *     (typically within ~30 minutes) and marks it `'interrupted'`.
 *   - SIGTERM / SIGINT trigger a best-effort `/complete` with
 *     `status='interrupted'` before exit.
 */
export default class WrightfulReporter implements Reporter {
  private client: StreamClient | null = null;
  private uploader: ArtifactUploader | null = null;
  private runId: string | null = null;
  private runUrl: string | null = null;
  private ci: CIInfo | null = null;
  private batcher: Batcher<EnqueuedTest> | null = null;
  private accumulator = new TestAccumulator();
  private artifactTasks: Promise<void>[] = [];
  private allowedRoot = "";
  private artifactMode: ArtifactMode = DEFAULT_ARTIFACT_MODE;
  private rootDir: string | null = null;
  private startedAt = 0;
  private playwrightVersion = "unknown";
  // Observability counters surfaced in the end-of-suite summary line.
  private streamed = 0;
  private streamFailed = 0;
  private artifactsOk = 0;
  private artifactsFailed = 0;
  // Per-status tallies, used for the PR comment summary.
  private counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, timedout: 0 };
  // Signal-handler state so we only attempt the shutdown /complete once.
  private shuttingDown = false;
  private signalHandlersInstalled = false;

  constructor(private options: ReporterOptions = {}) {}

  private get baseUrl(): string | null {
    return this.options.url ?? process.env.WRIGHTFUL_URL ?? null;
  }
  private get token(): string | null {
    return this.options.token ?? process.env.WRIGHTFUL_TOKEN ?? null;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.playwrightVersion = config.version ?? "unknown";
    this.artifactMode = this.options.artifacts ?? DEFAULT_ARTIFACT_MODE;
    this.rootDir = config.rootDir ?? null;

    const baseUrl = this.baseUrl;
    const token = this.token;
    if (!baseUrl || !token) {
      warn("WRIGHTFUL_URL or WRIGHTFUL_TOKEN not set — streaming disabled.");
      return;
    }

    this.client = new StreamClient(baseUrl, token);
    this.uploader = new ArtifactUploader(
      this.client,
      warn,
      ARTIFACT_UPLOAD_CONCURRENCY,
    );

    const allTests = suite.allTests();
    const plannedTests = allTests.map((t) =>
      buildTestDescriptor(t, this.rootDir),
    );

    const ci = detectCI();
    this.ci = ci;
    // Synthetic-monitoring overrides. A scheduled monitor launches this suite
    // in a container with `WRIGHTFUL_RUN_ORIGIN=synthetic`, `WRIGHTFUL_MONITOR_ID`
    // = the monitor row's id, and `WRIGHTFUL_IDEMPOTENCY_KEY` = the pre-known
    // execution id (honored inside generateIdempotencyKey). Threading origin +
    // monitorId onto the open-run payload makes the resulting run attributable
    // to its monitor execution; absent these, a normal CI run omits them and the
    // dashboard defaults `origin` to "ci".
    const runOrigin = resolveRunOrigin(process.env.WRIGHTFUL_RUN_ORIGIN);
    const monitorId = process.env.WRIGHTFUL_MONITOR_ID || null;
    const payload = {
      idempotencyKey: generateIdempotencyKey(ci?.ciBuildId),
      run: {
        ciProvider: ci?.ciProvider ?? null,
        ciBuildId: ci?.ciBuildId ?? null,
        branch: ci?.branch ?? null,
        environment: this.options.environment ?? null,
        commitSha: ci?.commitSha ?? null,
        commitMessage: ci?.commitMessage ?? null,
        prNumber: ci?.prNumber ?? null,
        repo: ci?.repo ?? null,
        actor: ci?.actor ?? null,
        reporterVersion: REPORTER_VERSION,
        playwrightVersion: this.playwrightVersion,
        expectedTotalTests: plannedTests.length,
        plannedTests,
        origin: runOrigin,
        monitorId,
      },
    };

    // Open the run in the background so enqueues can start immediately. The
    // batcher's sequential flush chain naturally waits for runId before any
    // appendResults call fires.
    const openPromise = this.client.openRun(payload).then(
      (r) => {
        this.runId = r.runId;
        this.runUrl = r.runUrl;
      },
      (err: Error) => {
        if (err instanceof AuthError) {
          warn(err.message);
        } else {
          warn(`openRun failed: ${err.message}. Streaming disabled.`);
        }
        this.client = null;
      },
    );

    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const flushIntervalMs =
      this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    this.batcher = new Batcher<EnqueuedTest>({
      batchSize,
      flushIntervalMs,
      flush: async (batch) => {
        await openPromise;
        if (!this.client || !this.runId) {
          this.streamFailed += batch.length;
          return;
        }
        const mapping = await this.client.appendResults(
          this.runId,
          batch.map((e) => e.payload),
        );
        this.streamed += batch.length;
        this.fireArtifactUploads(this.runId, batch, mapping);
      },
      onFailure: (batch, err) => {
        if (err instanceof AuthError) {
          warn(err.message);
        } else {
          warn(
            `appendResults failed: ${err.message}. ${batch.length} result(s) dropped.`,
          );
        }
        this.streamFailed += batch.length;
      },
    });

    // Resolve the cwd-based root used to validate attachment paths. Doing
    // this once up-front avoids a per-attachment realpath on cwd.
    this.artifactTasks.push(
      realpath(process.cwd()).then(
        (p) => {
          this.allowedRoot = p;
        },
        () => {
          this.allowedRoot = process.cwd();
        },
      ),
    );

    this.installSignalHandlers();
  }

  /**
   * Best-effort SIGTERM/SIGINT handlers. GitHub Actions sends SIGTERM first
   * on cancellation, then SIGKILL ~10s later. We use that grace window to
   * mark the run `interrupted`. SIGKILL itself is uncatchable; the
   * dashboard's cron watchdog handles that case.
   */
  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const handle = (signal: NodeJS.Signals) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      warn(`received ${signal} — attempting best-effort /complete.`);
      const task = async () => {
        if (this.client && this.runId) {
          try {
            await this.client.completeRun(
              this.runId,
              "interrupted",
              Date.now() - this.startedAt,
              { maxRetries: 0, timeoutMs: SHUTDOWN_COMPLETE_TIMEOUT_MS },
            );
          } catch {
            // Intentionally swallow — we're on our way out either way. The
            // dashboard watchdog picks up anything we didn't finalize.
          }
        }
        // Deliberately do NOT call process.exit() here. We only piggy-back the
        // signal to fire a best-effort /complete and then get out of the way:
        //   - SIGINT (local Ctrl-C): Playwright installs its own handler and
        //     receives the same signal — it does the graceful worker shutdown,
        //     flushes every other reporter, and computes the exit code. Calling
        //     process.exit() here would preempt all of that the instant our
        //     /complete settles, truncating output and overriding Playwright's
        //     exit code. So we let Playwright own termination.
        //   - SIGTERM (CI cancellation): the runner is being torn down anyway,
        //     usually followed by SIGKILL after a grace period. We mark the run
        //     'interrupted' best-effort and let that teardown proceed; the
        //     dashboard watchdog finalizes the run if we never got the chance.
        // Our handler is `process.once`, so it can't re-fire or loop.
      };
      void task();
    };
    process.once("SIGTERM", handle);
    process.once("SIGINT", handle);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.batcher) return;
    const done = this.accumulator.record(test, result);
    if (done) this.artifactTasks.push(this.enqueueDone(done));
  }

  private async enqueueDone(entry: PendingTest): Promise<void> {
    const payload = buildPayload(entry, this.rootDir);
    this.counts[payload.status]++;
    const attachments =
      this.artifactMode === "none"
        ? []
        : shouldCollectArtifacts(this.artifactMode, entry.test)
          ? await this.collectArtifacts(entry)
          : [];
    this.batcher?.enqueue({ payload, artifacts: attachments });
  }

  private async collectArtifacts(
    entry: PendingTest,
  ): Promise<PreparedArtifact[]> {
    // Ensure allowedRoot has been resolved before we validate any paths.
    await Promise.all(this.artifactTasks.filter(Boolean));
    const out: PreparedArtifact[] = [];
    for (const result of entry.results) {
      for (const attachment of result.attachments ?? []) {
        // Only on-disk attachments (those with a `path`) are uploaded.
        // Inline body attachments are typically small diagnostic text
        // embedded in the report — we skip them.
        if (!attachment.path) continue;
        const resolved = await safeResolvedPath(
          attachment.path,
          this.allowedRoot,
        );
        if (!resolved) continue;
        const size = await safeSize(resolved);
        if (size === null) continue;
        const baseType = classifyAttachment(
          attachment.name,
          attachment.contentType,
        );
        const snapshot =
          baseType === "screenshot"
            ? parseSnapshotAttachment(attachment.name)
            : null;
        out.push({
          type: baseType,
          name: attachment.name,
          contentType: attachment.contentType,
          sizeBytes: size,
          localPath: resolved,
          attempt: result.retry,
          role: snapshot?.role,
          snapshotName: snapshot?.snapshotName,
        });
      }
    }
    return promoteSnapshotTriples(out);
  }

  /**
   * Delegate the flushed batch's artifact pipeline to {@link ArtifactUploader}.
   * The returned promise is tracked on `artifactTasks` (not awaited here) so
   * uploads overlap with subsequent flushes; `onEnd` awaits them before
   * `/complete`. The `{ ok, failed }` counts are folded into the summary
   * tallies once the upload settles.
   */
  private fireArtifactUploads(
    runId: string,
    batch: EnqueuedTest[],
    mapping: Array<{ clientKey: string; testResultId: string }>,
  ): void {
    if (!this.uploader) return;
    const uploader = this.uploader;
    this.artifactTasks.push(
      uploader
        .upload(
          runId,
          batch.map((e) => ({
            clientKey: e.payload.clientKey,
            artifacts: e.artifacts,
          })),
          mapping,
        )
        .then(({ ok, failed }) => {
          this.artifactsOk += ok;
          this.artifactsFailed += failed;
        }),
    );
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.shuttingDown) return;

    // Any test whose "done" trigger never fired (e.g. interrupted worker
    // killed the run mid-attempt) gets flushed here with whatever state we
    // have. Better to report partial data than lose it.
    for (const entry of this.accumulator.drainPending()) {
      this.artifactTasks.push(this.enqueueDone(entry));
    }

    // enqueueDone tasks (pushed from onTestEnd) resolve asynchronously and
    // their `batcher.enqueue` call fires only after collectArtifacts settles.
    // Await them first so drain actually sees every finished test — otherwise
    // tests whose `enqueueDone` was still in flight when drain ran would land
    // in a new batch with no one left to flush it.
    await Promise.all(this.artifactTasks);
    if (this.batcher) {
      await this.batcher.drain();
    }
    // drain's flush callback fires artifact uploads, which push new promises
    // onto artifactTasks. Await those too.
    await Promise.all(this.artifactTasks);

    const durationMs = Date.now() - this.startedAt;

    let completeFailed = false;
    let runStatus: ReturnType<typeof mapFullResultStatus> | null = null;
    if (this.client && this.runId) {
      runStatus = mapFullResultStatus(result.status);
      try {
        await this.client.completeRun(this.runId, runStatus, durationMs);
      } catch (err) {
        completeFailed = true;
        warn(
          `completeRun failed after retries: ${err instanceof Error ? err.message : String(err)}`,
        );
        warn(
          "Run may remain at status='running' until the dashboard watchdog finalizes it (typically within ~30 minutes).",
        );
      }
    }

    if (!completeFailed && runStatus) {
      await this.maybePostPrComment(runStatus, durationMs);
    }

    this.emitSummary(completeFailed);
  }

  private async maybePostPrComment(
    runStatus: "passed" | "failed" | "timedout" | "interrupted",
    durationMs: number,
  ): Promise<void> {
    const gate = shouldPostPrComment(
      this.options.postPrComment ?? false,
      this.ci,
      process.env,
    );
    if (!gate.ok) return;
    if (!this.baseUrl || !this.ci?.repo || !this.ci.prNumber) return;

    const total =
      this.counts.passed +
      this.counts.failed +
      this.counts.flaky +
      this.counts.skipped +
      this.counts.timedout;

    const summary: RunSummary = {
      status: runStatus,
      durationMs,
      passed: this.counts.passed,
      failed: this.counts.failed,
      flaky: this.counts.flaky,
      skipped: this.counts.skipped,
      timedout: this.counts.timedout,
      total,
      runUrl: this.runUrl,
      dashboardUrl: this.baseUrl,
      repo: this.ci.repo,
      prNumber: this.ci.prNumber,
      environment: this.options.environment ?? null,
      commitSha: this.ci.commitSha,
    };
    try {
      const result = await postPrComment(summary, gate.token);
      warn(
        `PR comment ${result.status} on ${this.ci.repo}#${this.ci.prNumber}.`,
      );
    } catch (err) {
      // Cross-fork PRs hit 403 here — the runner's GITHUB_TOKEN is read-only.
      // Log and continue; the run itself is unaffected.
      warn(
        `PR comment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private emitSummary(completeFailed: boolean): void {
    const total = this.streamed + this.streamFailed;
    const parts = [`streamed ${this.streamed}/${total} test(s)`];
    const totalArtifacts = this.artifactsOk + this.artifactsFailed;
    if (totalArtifacts > 0) {
      parts.push(`uploaded ${this.artifactsOk}/${totalArtifacts} artifact(s)`);
    }
    if (this.streamFailed > 0) {
      parts.push(`${this.streamFailed} result(s) dropped`);
    }
    if (completeFailed) {
      parts.push("complete call failed — watchdog will finalize");
    }
    warn(parts.join("; ") + ".");
  }

  printsToStdio(): boolean {
    return false;
  }
}

/**
 * Extract the identifying fields for a test case (file, title, project,
 * derived testId). Used by both the open-run prefill (to send the full
 * planned list at onBegin) and `buildPayload` (when a test actually emits
 * a result) — so the same test lands with the same testId, enabling the
 * server to upsert /results rows onto the prefilled queued row.
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
  const testId = computeTestId(file, titlePath, projectName);
  return {
    testId,
    title: titlePath.join(" > "),
    file,
    projectName: projectName || null,
  };
}

/** Playwright uses "timedOut"; our wire format uses "timedout". */
function normaliseAttemptStatus(
  status: TestResult["status"],
): TestAttemptPayload["status"] {
  if (status === "timedOut") return "timedout";
  if (status === "failed") return "failed";
  if (status === "passed") return "passed";
  // "interrupted" and anything unexpected → surface as skipped rather than
  // invent a new enum value on the wire.
  return "skipped";
}

export function buildPayload(
  entry: PendingTest,
  rootDir: string | null = null,
): TestResultPayload {
  const { test, results } = entry;
  const descriptor = buildTestDescriptor(test, rootDir);

  const totalDuration = results.reduce((s, r) => s + r.duration, 0);
  const lastResult = results[results.length - 1];
  const failing = results.find(
    (r) => r.status === "failed" || r.status === "timedOut",
  );

  const status = mapOutcome(test, lastResult);
  const errorSource = status === "flaky" ? failing : lastResult;

  // One entry per Playwright attempt, ordered by `retry` (0 = initial).
  // Preserves each attempt's own error instead of collapsing to one, so
  // the test detail page can stop inferring which attempt "carries" the
  // failure.
  const attempts: TestAttemptPayload[] = [...results]
    .sort((a, b) => a.retry - b.retry)
    .map((r) => ({
      attempt: r.retry,
      status: normaliseAttemptStatus(r.status),
      durationMs: Math.round(r.duration),
      errorMessage: r.errors?.[0]?.message ?? null,
      errorStack: r.errors?.[0]?.stack ?? null,
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
    errorMessage: errorSource?.errors?.[0]?.message ?? null,
    errorStack: errorSource?.errors?.[0]?.stack ?? null,
    workerIndex:
      lastResult && lastResult.workerIndex >= 0 ? lastResult.workerIndex : 0,
    tags: test.tags ?? [],
    annotations: test.annotations.map((a) => ({
      type: a.type,
      description: a.description,
    })),
    attempts,
  };
}

function mapOutcome(
  test: TestCase,
  lastResult: TestResult | undefined,
): "passed" | "failed" | "flaky" | "skipped" | "timedout" {
  const outcome = test.outcome();
  switch (outcome) {
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

function shouldCollectArtifacts(mode: ArtifactMode, test: TestCase): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  // `failed` mode: upload for failed or flaky tests.
  const outcome = test.outcome();
  return outcome === "unexpected" || outcome === "flaky";
}

/**
 * Map the `WRIGHTFUL_RUN_ORIGIN` env value to the wire `origin` enum. Only the
 * literal `"synthetic"` flips the origin; anything else (unset, empty, or an
 * unexpected value) falls back to `"ci"` — the safe default for an ordinary
 * reporter run, matching the dashboard's server-side default.
 */
function resolveRunOrigin(raw: string | undefined): "ci" | "synthetic" {
  return raw === "synthetic" ? "synthetic" : "ci";
}

function mapFullResultStatus(
  status: FullResult["status"],
): "passed" | "failed" | "timedout" | "interrupted" {
  switch (status) {
    case "passed":
      return "passed";
    case "timedout":
      return "timedout";
    case "interrupted":
      return "interrupted";
    case "failed":
    default:
      return "failed";
  }
}
