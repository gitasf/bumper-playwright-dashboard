import { realpath } from "node:fs/promises";
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
  normalizeContentType,
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
import {
  detectCI,
  generateIdempotencyKey,
  resolveCIExecutionPolicy,
  type CIInfo,
} from "./ci.js";
import { AuthError, StreamClient } from "./client.js";
import { readCodeowners } from "./codeowners-file.js";
import {
  postPrComment,
  projectCommentScope,
  shouldPostPrComment,
  type RunSummary,
} from "./pr-comment.js";
import {
  applyQuarantine,
  fetchQuarantine,
  type QuarantineMap,
} from "./quarantine.js";
import { MAX_PLANNED_TESTS, MAX_RESULTS_PER_BATCH } from "./limits.js";
import { buildPayload, buildTestDescriptor } from "./test-payload.js";
import type {
  ArtifactMode,
  ReporterOptions,
  ShardInfo,
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
// Wall-clock budget for the whole onEnd drain + complete. Without it, every
// call is individually bounded but a slow dashboard with many artifacts can
// stretch onEnd to hours. Overridable via `shutdownTimeoutMs`.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 600_000;
// Slice of the budget reserved for the final `/complete` call so it still
// fires even when uploads eat the rest.
const COMPLETE_RESERVE_MS = 30_000;

function cliProjectFilters(argv: readonly string[]): string[] {
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--project=")) {
      filters.push(arg.slice("--project=".length));
      continue;
    }
    if (arg !== "--project") continue;
    while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      filters.push(argv[++i]);
    }
  }
  return filters;
}

function selectedProjectNames(config: FullConfig): string[] {
  const cliFilters = cliProjectFilters(config.argv ?? []);
  const names =
    cliFilters.length > 0
      ? cliFilters
      : config.projects.map((project) => project.name);
  return [...new Set(names)].sort();
}

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
export { buildPayload, buildTestDescriptor } from "./test-payload.js";

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
  // Resolves to the project's quarantine list, indexed by testId. Fetched at
  // onBegin in parallel with openRun and awaited in enqueueDone before a
  // payload is built, so a quarantined failure is demoted to `skipped` on the
  // wire. Defaults to an empty map (no quarantine) — the fetch swallows every
  // error, so it can never break a run.
  private quarantinePromise: Promise<QuarantineMap> = Promise.resolve(
    new Map(),
  );
  private runUrl: string | null = null;
  // Resolves once the run is open (or open failed). Awaited in `onEnd` before
  // `/complete` so a run with zero flushable results — an all-skipped suite, or
  // an empty one — still reliably opens: the open is now gated behind an async
  // CODEOWNERS read (roadmap 2.3), so it no longer fires synchronously inside
  // `onBegin`, and the batcher only awaits it when it has a batch to flush.
  private openPromise: Promise<void> = Promise.resolve();
  private ci: CIInfo | null = null;
  private projectNames: string[] = [];
  /**
   * Playwright shard coordinates (`config.shard`) for a sharded run, else null.
   * Captured at `onBegin`, sent on the open payload AND the final `/complete` so
   * the dashboard keeps the run at status='running' until every shard has
   * reported (rather than finalizing on the first shard's /complete).
   */
  private shard: ShardInfo | null = null;
  private batcher: Batcher<EnqueuedTest> | null = null;
  private accumulator = new TestAccumulator();
  // Set (not array): a settled task removes itself in trackTask's `finally`,
  // keeping this bounded by in-flight work rather than retaining one settled
  // promise per finished test for the whole run.
  private artifactTasks = new Set<Promise<void>>();
  // Tracked tasks still in flight — the count surfaced when the shutdown
  // budget expires and work has to be abandoned.
  private pendingTasks = 0;
  private allowedRoot = "";
  // Resolved cwd realpath used to validate attachment paths. Kept separate
  // from artifactTasks so collectArtifacts can await just this resolution
  // instead of the whole task graph (which would be O(n²) and serialize
  // enqueues behind all in-flight uploads).
  private allowedRootReady: Promise<void> = Promise.resolve();
  private warnedOutsideRoot = false;
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
  // Set on the first mid-run AuthError from a /results flush. Gates the
  // streaming path only: later batches are dropped locally without network
  // calls, but the client stays alive so onEnd (and the signal handler) can
  // still attempt the single /complete — completeRun's server-side recompute
  // makes a successful complete strictly better than leaving the run at
  // 'running' for the watchdog to interrupt.
  private streamingDisabled = false;
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
    // Read project identity from configuration/CLI rather than the tests in
    // this shard. A shard or grep can contain no tests (or only one project's
    // slice), but every shard still needs the complete selected project set.
    this.projectNames = selectedProjectNames(config);
    // Playwright sets `config.shard` only under `--shard`; remap its
    // `{ current, total }` to the wire's `{ index, total }`. Null for a
    // non-sharded run, which keeps the open/complete payloads at their legacy
    // shape and the dashboard on the finalize-on-first-complete path.
    this.shard = config.shard
      ? { index: config.shard.current, total: config.shard.total }
      : null;

    const baseUrl = this.baseUrl;
    const token = this.token;
    if (!baseUrl || !token) {
      warn("WRIGHTFUL_URL or WRIGHTFUL_TOKEN not set — streaming disabled.");
      return;
    }

    const ci = detectCI();
    this.ci = ci;
    const executionPolicy = resolveCIExecutionPolicy(ci, {
      nativeSharded: this.shard !== null,
      hasExplicitIdempotencyKey: Boolean(process.env.WRIGHTFUL_IDEMPOTENCY_KEY),
    });
    if (executionPolicy.status === "blocked") {
      warn(`${executionPolicy.reason} Streaming disabled.`);
      return;
    }
    if (executionPolicy.warning) warn(executionPolicy.warning);

    this.client = new StreamClient(baseUrl, token);
    this.uploader = new ArtifactUploader(
      this.client,
      warn,
      ARTIFACT_UPLOAD_CONCURRENCY,
    );

    // Fetch the quarantine list in the background — do NOT block run-open on
    // it. `enqueueDone` awaits this map before building each payload (like the
    // batcher awaits `openPromise`); `fetchQuarantine` swallows all errors to
    // an empty map, so quarantine can never delay or break a run.
    this.quarantinePromise = fetchQuarantine(this.client);

    const allTests = suite.allTests();
    const plannedTests = allTests.map((t) =>
      buildTestDescriptor(t, this.rootDir),
    );
    const plannedTestsToSend = plannedTests.slice(0, MAX_PLANNED_TESTS);
    if (plannedTestsToSend.length < plannedTests.length) {
      warn(
        `suite has ${plannedTests.length} tests, over the dashboard's planned-test cap of ${MAX_PLANNED_TESTS}; ` +
          `sending the first ${MAX_PLANNED_TESTS} as queued placeholders. Every test's result still streams — ` +
          `only the surplus pre-run placeholders are omitted.`,
      );
    }

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
      // Provider attempt prevents a workflow rerun from mutating its previous
      // dashboard execution. The configured/CLI-selected project set keeps
      // project matrix legs separate while remaining identical across native
      // shards, including shards with no tests. WRIGHTFUL_MATRIX_KEY covers
      // arbitrary matrix axes Playwright cannot see.
      idempotencyKey: generateIdempotencyKey(ci?.ciBuildId, {
        jobName: ci?.ciJobName ?? null,
        runAttempt: executionPolicy.runAttempt,
        projectNames: this.projectNames,
        matrixKey: process.env.WRIGHTFUL_MATRIX_KEY ?? null,
      }),
      // Sent only for a sharded suite (spread away entirely otherwise, so a
      // non-sharded open is byte-for-byte unchanged). Tells the dashboard how
      // many shards this run must wait for before it may finalize.
      ...(this.shard ? { shard: this.shard } : {}),
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
        plannedTests: plannedTestsToSend,
        origin: runOrigin,
        monitorId,
      },
    };

    // Open the run in the background so enqueues can start immediately. The
    // batcher's sequential flush chain naturally waits for runId before any
    // appendResults call fires. Read the repo's CODEOWNERS off disk first and
    // attach it to the payload (roadmap 2.3) so the dashboard can derive test
    // ownership — best-effort: a missing/oversize file yields null and the
    // field is simply omitted (`readCodeowners` never throws).
    const client = this.client;
    const rootDir = this.rootDir;
    const openPromise = readCodeowners(rootDir)
      .then((codeowners) =>
        client.openRun(codeowners ? { ...payload, codeowners } : payload),
      )
      .then(
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
    // Expose the open to `onEnd` so a result-less suite still awaits the open
    // before /complete (the batcher only awaits it on a flush).
    this.openPromise = openPromise;

    const requestedBatchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (requestedBatchSize > MAX_RESULTS_PER_BATCH) {
      warn(
        `batchSize ${requestedBatchSize} exceeds the dashboard's per-batch cap of ${MAX_RESULTS_PER_BATCH}; ` +
          `clamping to ${MAX_RESULTS_PER_BATCH} (larger batches are rejected wholesale).`,
      );
    }
    const batchSize = Math.max(
      1,
      Math.min(requestedBatchSize, MAX_RESULTS_PER_BATCH),
    );
    const flushIntervalMs =
      this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    this.batcher = new Batcher<EnqueuedTest>({
      batchSize,
      flushIntervalMs,
      flush: async (batch) => {
        await openPromise;
        if (this.streamingDisabled || !this.client || !this.runId) {
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
          // Auth failure is terminal for streaming: warn once and stop
          // POSTing /results (subsequent batches drop locally instead of
          // re-POSTing, and re-warning, with the same bad credentials). The
          // client deliberately stays alive: onEnd still attempts the single
          // /complete. If the rejection was a transient proxy/WAF hiccup
          // that call finalizes the run; if the key is genuinely revoked it
          // fails once with a caught warning (4xx is never retried) — no
          // retry storm either way.
          if (!this.streamingDisabled) {
            this.streamingDisabled = true;
            warn(`${err.message} Streaming disabled.`);
          }
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
    this.allowedRootReady = realpath(process.cwd()).then(
      (p) => {
        this.allowedRoot = p;
      },
      () => {
        this.allowedRoot = process.cwd();
      },
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
        // Deliberately not gated on `streamingDisabled` — that flag only
        // stops doomed /results POSTs. The one best-effort /complete is
        // still worth attempting with a possibly-bad key (maxRetries: 0, so
        // a genuine revocation costs a single swallowed failure).
        if (this.client && this.runId) {
          try {
            await this.client.completeRun(
              this.runId,
              "interrupted",
              Date.now() - this.startedAt,
              {
                maxRetries: 0,
                timeoutMs: SHUTDOWN_COMPLETE_TIMEOUT_MS,
                // Record THIS shard as interrupted so the run can finalize on
                // the surviving shards' completes instead of waiting for the
                // watchdog (a sharded run stays 'running' until every shard has
                // a row).
                shard: this.shard ?? undefined,
              },
            );
          } catch {
            // Intentionally swallow — we're on our way out either way. The
            // dashboard watchdog picks up anything we didn't finalize.
          }
        }
        // Termination handoff differs by signal — we only piggy-back it to fire
        // one best-effort /complete, then get out of the way:
        //   - SIGINT (local Ctrl-C): Playwright installs its OWN SIGINT handler
        //     and receives the same signal — it does the graceful worker
        //     shutdown, flushes every other reporter, and computes the exit code.
        //     Calling process.exit()/re-raising here would preempt all of that the
        //     instant our /complete settles, truncating output and overriding
        //     Playwright's exit code. So we let Playwright own termination.
        //   - SIGTERM (CI cancellation): Playwright (≤1.61) does NOT watch
        //     SIGTERM, and installing ANY listener removes Node's default
        //     (immediate exit) — so if we just returned, the process would linger
        //     (ignoring the SIGTERM) until the runner's SIGKILL ~10s later. Our
        //     `process.once` listener is already removed, so RE-RAISE SIGTERM to
        //     pass it through to the default (terminate now, exit 143) once our
        //     best-effort /complete has settled. The dashboard watchdog finalizes
        //     the run if we never got the chance.
        if (signal === "SIGTERM") {
          process.kill(process.pid, "SIGTERM");
        }
      };
      void task();
    };
    process.once("SIGTERM", handle);
    process.once("SIGINT", handle);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.batcher) return;
    const done = this.accumulator.record(test, result);
    if (done) this.trackTask(this.enqueueDone(done));
  }

  /**
   * Track a background task on `artifactTasks` with a last-resort rejection
   * guard. A bare rejected promise would surface as an unhandledRejection
   * (killing the user's suite) and make `onEnd`'s `Promise.all` reject before
   * drain/complete — so tracked tasks must never reject. `pendingTasks` counts
   * in-flight tasks for the shutdown-budget warning; the task removes itself
   * from the set once settled.
   */
  private trackTask(task: Promise<void>): void {
    this.pendingTasks++;
    const tracked: Promise<void> = task
      .catch((err: unknown) => {
        warn(
          `internal task failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.pendingTasks--;
        this.artifactTasks.delete(tracked);
      });
    this.artifactTasks.add(tracked);
  }

  private async enqueueDone(entry: PendingTest): Promise<void> {
    try {
      const built = buildPayload(
        entry,
        this.rootDir,
        this.shard?.index ?? null,
      );
      // Demote a quarantined hard failure to `skipped` on the wire. The map is
      // resolved by the time the first test ends in any real run, but await it
      // here so we never race a slow fetch; it's empty on any fetch failure, so
      // this is a no-op when quarantine is unavailable.
      const quarantine = await this.quarantinePromise;
      const payload = applyQuarantine(built, quarantine);
      this.counts[payload.status]++;
      const attachments =
        this.artifactMode === "none"
          ? []
          : shouldCollectArtifacts(this.artifactMode, entry.test)
            ? await this.collectArtifacts(entry)
            : [];
      this.batcher?.enqueue({ payload, artifacts: attachments });
    } catch (err) {
      // Reporter must never fail the suite: swallow, count the result as
      // dropped, and keep going.
      this.streamFailed++;
      warn(
        `failed to enqueue result for "${entry.test.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async collectArtifacts(
    entry: PendingTest,
  ): Promise<PreparedArtifact[]> {
    // Ensure allowedRoot has been resolved before we validate any paths.
    await this.allowedRootReady;
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
        if (!resolved) {
          // Warn once per run (not per file) — typically an outputDir
          // configured outside the invocation cwd.
          if (!this.warnedOutsideRoot) {
            this.warnedOutsideRoot = true;
            warn(
              `skipping attachment "${attachment.path}" — it resolves outside the allowed root "${this.allowedRoot}" ` +
                `(the directory Playwright was invoked from) or is unreadable. Further such attachments are skipped silently.`,
            );
          }
          continue;
        }
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
          // Normalised to the dashboard's allowlist — one non-allowlisted
          // type would 400 the whole register batch server-side.
          contentType: normalizeContentType(attachment.contentType),
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
    this.trackTask(
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

  /**
   * Await `task` until `deadline` (epoch ms). Returns false on expiry,
   * true once the task settles (fulfilled OR rejected) — abandoned work
   * keeps running unawaited, which is safe because every tracked task
   * swallows its own failures. Never rejects.
   *
   * Thin wrapper over {@link withDeadline} (the single timer primitive):
   * the task is first mapped to a never-rejecting "settled" promise, so the
   * only rejection {@link withDeadline} can surface here is its own timeout —
   * which maps to `false`.
   */
  private async settleWithinDeadline(
    task: Promise<unknown>,
    deadline: number,
  ): Promise<boolean> {
    const settled = task.then(
      () => true,
      () => true,
    );
    try {
      return await this.withDeadline(settled, deadline);
    } catch {
      return false;
    }
  }

  /**
   * Await `task` until `deadline` (epoch ms), propagating the task's value or
   * rejection; rejects with a timeout error on expiry. The underlying task
   * keeps its handlers attached, so a late rejection after expiry can never
   * surface as an unhandledRejection.
   */
  private withDeadline<T>(task: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`timed out after ${remaining}ms (shutdown budget)`)),
        Math.max(remaining, 0),
      );
      timer.unref?.();
      task.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.shuttingDown) return;

    // Wall-clock budget for the whole drain + complete. Each call below is
    // individually bounded, but with many artifacts against a slow dashboard
    // the sum could otherwise stretch to hours. A slice is reserved for the
    // final `/complete` so it still fires when uploads eat the budget.
    const budgetMs =
      this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    const drainDeadline =
      deadline - Math.min(COMPLETE_RESERVE_MS, budgetMs / 2);

    // Any test whose "done" trigger never fired (e.g. interrupted worker
    // killed the run mid-attempt) gets flushed here with whatever state we
    // have. Better to report partial data than lose it.
    for (const entry of this.accumulator.drainPending()) {
      this.trackTask(this.enqueueDone(entry));
    }

    // enqueueDone tasks (pushed from onTestEnd) resolve asynchronously and
    // their `batcher.enqueue` call fires only after collectArtifacts settles.
    // Await them first so drain actually sees every finished test — otherwise
    // tests whose `enqueueDone` was still in flight when drain ran would land
    // in a new batch with no one left to flush it.
    const enqueuesSettled = await this.settleWithinDeadline(
      Promise.all(this.artifactTasks),
      drainDeadline,
    );
    // The drain is always STARTED — even when the enqueue stage exhausted the
    // budget — so fully-buffered result batches are at least handed to fetch;
    // only the awaiting below is subject to the remaining budget. The promise
    // goes through trackTask, so an abandoned drain keeps running unawaited
    // without ever surfacing an unhandled rejection. Its flush callback fires
    // artifact uploads that push new promises onto artifactTasks — awaited by
    // the final stage. Short-circuits on budget expiry.
    const drainTask = this.batcher?.drain() ?? Promise.resolve();
    this.trackTask(drainTask);
    const drained =
      enqueuesSettled &&
      (await this.settleWithinDeadline(drainTask, drainDeadline)) &&
      (await this.settleWithinDeadline(
        Promise.all(this.artifactTasks),
        drainDeadline,
      ));
    if (!drained) {
      warn(
        `shutdown budget of ${budgetMs}ms exhausted — abandoned ${this.pendingTasks} in-flight task(s) (enqueues, artifact uploads, result-batch drain); they continue unawaited. Completing the run anyway.`,
      );
    }

    const durationMs = Date.now() - this.startedAt;

    // Ensure the run is open before /complete. A flushing suite already awaited
    // this inside the batcher, but a result-less suite (all-skipped / empty)
    // never flushed, so without this the open — now gated behind an async
    // CODEOWNERS read (roadmap 2.3) rather than firing synchronously in
    // onBegin — could still be in flight here and /complete would be skipped.
    // `openPromise` never rejects (its handler catches + nulls the client).
    await this.openPromise;

    let completeFailed = false;
    let runStatus: ReturnType<typeof mapFullResultStatus> | null = null;
    if (this.client && this.runId) {
      runStatus = mapFullResultStatus(result.status);
      try {
        await this.withDeadline(
          // Carry the shard identity so the dashboard records THIS shard's
          // completion and only flips the run terminal once every shard has
          // reported. `result.status` reflects only this shard's tests.
          this.client.completeRun(this.runId, runStatus, durationMs, {
            shard: this.shard ?? undefined,
          }),
          deadline,
        );
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
    if (this.shard) {
      if (this.options.postPrComment) {
        warn(
          "PR comment skipped for a native shard; enable the Wrightful GitHub App for aggregate sharded-run comments.",
        );
      }
      return;
    }
    const gate = shouldPostPrComment(
      this.options.postPrComment ?? false,
      this.ci,
      process.env,
    );
    if (!gate.ok) {
      // Only worth a warning when the user explicitly opted in — silence is
      // correct for the default-off path.
      if (this.options.postPrComment) {
        warn(`PR comment skipped: ${gate.reason}.`);
      }
      return;
    }
    const dashboardUrl = this.baseUrl;
    const projectToken = this.token;
    if (!dashboardUrl || !projectToken || !this.ci?.repo || !this.ci.prNumber) {
      return;
    }

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
      dashboardUrl,
      repo: this.ci.repo,
      prNumber: this.ci.prNumber,
      environment: this.options.environment ?? null,
      commitSha: this.ci.commitSha,
      commentScope: JSON.stringify({
        dashboard: dashboardUrl,
        runCollection: this.runUrl?.replace(
          /\/runs\/[^/?#]+(?:[?#].*)?$/,
          "/runs",
        ),
        projectCredential: this.runUrl
          ? null
          : projectCommentScope(projectToken, dashboardUrl),
        workflow:
          process.env.GITHUB_WORKFLOW_REF ??
          process.env.GITHUB_WORKFLOW ??
          null,
        job: this.ci.ciJobName,
        projects: this.projectNames,
        matrix: process.env.WRIGHTFUL_MATRIX_KEY ?? null,
        environment: this.options.environment ?? null,
      }),
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
