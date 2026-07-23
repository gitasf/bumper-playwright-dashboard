import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { env } from "void/env";
import { storage } from "void/storage";
import {
  selfHostedTraceViewerUrl,
  signArtifactDownloadToken,
  signedDownloadHref,
} from "@/lib/artifacts/tokens";
import { isReplayTraceArtifact } from "@/lib/artifacts/trace";
import { loadRunsListPage } from "@/lib/export";
import {
  loadMcpFlakyDiagnosis,
  loadMcpTestHistory,
  type McpTestHistorySelector,
} from "@/lib/mcp/diagnose";
import {
  ERROR_MESSAGE_SNIPPET_CHARS,
  listUserProjects,
  loadMcpArtifact,
  loadMcpFlakyTests,
  loadMcpRun,
  loadMcpRunTests,
  loadMcpTestResultDetail,
  truncateText,
} from "@/lib/mcp/queries";
import {
  EMPTY_FILTERS,
  RUN_ORIGIN_FILTERS,
  RUN_STATUSES,
  type RunsFilters,
} from "@/lib/runs/filters";
import { tenantScopeForUserBySlugs, type TenantScope } from "@/lib/scope";

/**
 * The Wrightful MCP server — the agent-facing read surface over runs → test
 * results → artifacts.
 *
 * Transport-agnostic: this module only builds the `McpServer` (tools +
 * instructions); the HTTP leg (Streamable HTTP via `@hono/mcp`, dual Bearer
 * auth via `middleware/02.api-auth.ts`) lives in `routes/api/mcp/index.ts`.
 *
 * Two authorization shapes ({@link McpAuthz}), matching the two credentials
 * the endpoint accepts:
 *
 *   - `project` — a project API key. The auth-checked `TenantScope` is fixed
 *     for the whole server; tools carry no tenancy arguments and cannot
 *     reach outside the key's project.
 *   - `user` — a Better Auth MCP OAuth access token (the browser
 *     authorize/consent flow). A user spans teams/projects, so every scoped
 *     tool gains required `team` + `project` slug arguments, resolved
 *     PER CALL through `tenantScopeForUserBySlugs` (a real membership
 *     check — the branded-scope funnel, not a trusted string), and a
 *     `list_projects` tool enumerates what the user can pick.
 *
 * All tools are read-only (`readOnlyHint`); payloads are JSON text blocks so
 * any MCP client can consume them, plus a real image block from
 * `get_artifact` for screenshots small enough to inline.
 * OAuth scopes are not an authorization boundary while this surface remains
 * read-only; project access is checked for each call.
 */
export type McpAuthz =
  | { kind: "project"; scope: TenantScope }
  | { kind: "user"; userId: string };

/** Raw bytes cap for inlining an image artifact as MCP image content (base64 ≈ ×4/3). */
export const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Raw bytes cap for inlining a text-ish artifact (logs, error context, JSON). */
export const INLINE_TEXT_MAX_BYTES = 128 * 1024;
/** Full-detail error stacks are still capped so one test can't flood a context window. */
const ERROR_STACK_MAX_CHARS = 20_000;

const COMMIT_ARG = z
  .string()
  .regex(/^[0-9a-fA-F]{4,40}$/, "a git SHA or SHA prefix (4–40 hex chars)");
const ISO_DATE_ARG = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** The extra tenancy arguments every scoped tool carries in `user` mode. */
const USER_SCOPE_SHAPE = {
  team: z.string().describe("Team slug — call list_projects to see yours"),
  project: z.string().describe("Project slug within the team"),
};

/** `env.WRIGHTFUL_PUBLIC_URL` without a trailing slash, for absolute links. */
function publicBase(): string {
  return env.WRIGHTFUL_PUBLIC_URL.replace(/\/+$/, "");
}

function runUrl(scope: TenantScope, runId: string): string {
  return `${publicBase()}/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${runId}`;
}

function testResultUrl(
  scope: TenantScope,
  runId: string,
  testResultId: string,
): string {
  return `${runUrl(scope, runId)}/tests/${testResultId}`;
}

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function isInlineableText(contentType: string): boolean {
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  return base.startsWith("text/") || base === "application/json";
}

export function isInlineableImage(contentType: string): boolean {
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  // The register-time allowlist (SAFE_CONTENT_TYPES) already excludes SVG;
  // this narrows further to formats MCP clients render as image blocks.
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(base);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A resolved artifact row (never null) as `loadMcpArtifact` returns it. */
type LoadedArtifact = NonNullable<Awaited<ReturnType<typeof loadMcpArtifact>>>;
/** One MCP content block (image/text) as `get_artifact` prepends before the metadata card. */
type ArtifactContentBlock = CallToolResult["content"][number];

/**
 * The metadata card `get_artifact` always returns: identity, size/role, the
 * signed download URL + its policy-owned lifetime, and — for replayable
 * traces — the browser viewer URL + local `show-trace` hint. Pure; the inline decision
 * layers its `warning`/`note` on top afterwards.
 */
function artifactMeta(
  artifact: LoadedArtifact,
  downloadUrl: string,
  downloadUrlExpiresInSeconds: number,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: artifact.id,
    testResultId: artifact.testResultId,
    type: artifact.type,
    name: artifact.name,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    attempt: artifact.attempt,
    role: artifact.role,
    snapshotName: artifact.snapshotName,
    downloadUrl,
    downloadUrlExpiresInSeconds,
  };
  if (isReplayTraceArtifact(artifact)) {
    // Our SELF-HOSTED viewer (same-origin) — the trace stays on this dashboard,
    // never the third-party trace.playwright.dev.
    meta.traceViewerUrl = selfHostedTraceViewerUrl(downloadUrl);
    meta.hint =
      "Open traceViewerUrl in a browser (self-hosted — the trace stays on this dashboard), or run: npx playwright show-trace <downloadUrl>";
  }
  return meta;
}

/**
 * Decide whether an artifact can be inlined as MCP content and, if so, fetch +
 * encode its bytes. Returns either the content `blocks` to prepend before the
 * metadata card, or a `reason` (+ the `meta` `key` to fold it under) explaining
 * why not:
 *
 *   - `note` — a size/content-type decision (too large, or not an inlineable
 *     type); the download URL is the answer.
 *   - `warning` — the row exists but the bytes are gone (retention swept R2
 *     first), so the download URL will 404 too — say so rather than hand out a
 *     dead link silently.
 */
async function inlineArtifact(
  artifact: LoadedArtifact,
): Promise<
  | { blocks: ArtifactContentBlock[] }
  | { key: "note" | "warning"; reason: string }
> {
  const inlineImage =
    isInlineableImage(artifact.contentType) &&
    artifact.sizeBytes <= INLINE_IMAGE_MAX_BYTES;
  const inlineText =
    !inlineImage &&
    isInlineableText(artifact.contentType) &&
    artifact.sizeBytes <= INLINE_TEXT_MAX_BYTES;

  if (!inlineImage && !inlineText) {
    const inlineableType =
      isInlineableImage(artifact.contentType) ||
      isInlineableText(artifact.contentType);
    return {
      key: "note",
      reason: inlineableType
        ? "Too large to inline — use downloadUrl."
        : "Not an inlineable content type — use downloadUrl.",
    };
  }

  const object = await storage.get(artifact.r2Key);
  if (!object) {
    return {
      key: "warning",
      reason:
        "Artifact bytes are no longer in storage (likely swept by retention); the download URL will 404.",
    };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const block: ArtifactContentBlock = inlineImage
    ? {
        type: "image",
        data: bytesToBase64(bytes),
        mimeType: artifact.contentType,
      }
    : { type: "text", text: new TextDecoder().decode(bytes) };
  return { blocks: [block] };
}

/**
 * Agent-facing rate definitions returned as a `semantics` field by the two
 * flake tools. Tool prose lives here at the tool layer, not in the loaders —
 * the rate formula itself is owned by `rankFlakyTests` and stays identical to
 * the dashboard flaky page.
 */
const FLAKY_RATE_SEMANTICS =
  "flakeRatePct = retryPasses / (retryPasses + passed), where retryPasses are results with status 'flaky' (failed then passed on retry) — the same definition as the dashboard flaky page.";
const FLAKY_DIAGNOSIS_SEMANTICS =
  "samples = passed + retryPasses + hardFailures; firstAttemptFailures = retryPasses + hardFailures; retryPasses = failed then passed on retry (status 'flaky'); hardFailures = failed or timedout results; flakeRatePct = retryPasses / (retryPasses + passed) — the same rate definition as the dashboard flaky page. Counters and representatives cover the full window; signatures are computed from each test's newest analyzedRows results (sampled when analyzedRows < samples), and coFailures from its newest coFailureRunsAnalyzed flaky runs.";

const FLOW_INSTRUCTIONS = `Typical debugging flow:
1. list_runs — find the run(s) you care about. Filter by pr (PR number), commit (SHA prefix), branch, or status:["failed"].
2. list_tests with status:"failed" — the failing tests of a run, each with a truncated error message.
3. get_test_result — full error message + stack, every retry attempt, and the artifact index (screenshots, traces, videos, error context).
4. get_artifact — small screenshots return inline as images and text artifacts as text; everything else (traces, videos) returns a signed download URL. Playwright traces also return a self-hosted viewer URL (same-origin — the trace stays on this dashboard), and can be inspected locally with: npx playwright show-trace <downloadUrl>.

For proactive flake hunting ("find and fix my flaky tests"), start with diagnose_flaky_tests: it returns the ranked tests with explicit counters, grouped error signatures, representative result ids, co-failures, and latest-run health. Use list_flaky_tests only when you need the cheaper ranking. For one known stable test id, spec file, or title/file search, call get_test_history to get its commit-to-attempt execution timeline in one response. Feed a representative testResultId into get_test_result for full errors and artifacts.

Timestamps are unix seconds. Lists are cursor-paginated: pass the returned nextCursor back to get the next page.`;

const PROJECT_INSTRUCTIONS = `Wrightful exposes Playwright test results for ONE project (the one the API key is scoped to).

${FLOW_INSTRUCTIONS}`;

const USER_INSTRUCTIONS = `Wrightful exposes Playwright test results for every project you are a member of.

Start with list_projects, then pass its team + project slugs to every other tool.

${FLOW_INSTRUCTIONS}`;

/** A tool that reads run-scoped data, written against a resolved `TenantScope`. */
interface ScopedToolDef<S extends ZodRawShapeCompat> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  run: (scope: TenantScope, args: ShapeOutput<S>) => Promise<CallToolResult>;
}

/**
 * Register one scoped tool under the given authorization shape. This is the
 * seam that keeps each tool defined ONCE while the two auth modes diverge:
 * `project` binds the fixed scope; `user` widens the schema with
 * {@link USER_SCOPE_SHAPE} and runs the membership check per call.
 */
function registerScopedTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  authz: McpAuthz,
  def: ScopedToolDef<S>,
): void {
  const annotations = { readOnlyHint: true } as const;
  // The `as ToolCallback<…>` casts below are TS plumbing, not a loosening:
  // `ToolCallback<Args>` is a conditional type on `Args`, which stays
  // unresolved while `S` is an open generic, so a correctly-typed concrete
  // callback is never assignable inside this helper. Each cast restates the
  // exact type the SDK resolves at the call site once `S` is bound.
  if (authz.kind === "project") {
    const handler = (args: ShapeOutput<S>) => def.run(authz.scope, args);
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations,
      },
      /* oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see block comment above */
      handler as unknown as ToolCallback<S>,
    );
    return;
  }
  const shape = { ...USER_SCOPE_SHAPE, ...def.inputSchema };
  const handler = async (args: ShapeOutput<typeof shape>) => {
    const scope = await tenantScopeForUserBySlugs(
      authz.userId,
      args.team,
      args.project,
    );
    if (!scope) {
      const available = await listUserProjects(authz.userId);
      const options = available
        .filter((p) => p.project !== null)
        .map((p) => `${p.team}/${p.project}`)
        .join(", ");
      return errorResult(
        `No project "${args.project}" in a team "${args.team}" you belong to. Available (team/project): ${options || "none"}.`,
      );
    }
    /* oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- widening drop of the team/project keys; extra properties are inert */
    return def.run(scope, args as ShapeOutput<S>);
  };
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: `${def.description} Scoped by the required team + project slugs (see list_projects).`,
      inputSchema: shape,
      annotations,
    },
    /* oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see block comment above */
    handler as unknown as ToolCallback<typeof shape>,
  );
}

export function buildMcpServer(authz: McpAuthz): McpServer {
  const server = new McpServer(
    { name: "wrightful", version: "1.0.0" },
    {
      instructions:
        authz.kind === "project" ? PROJECT_INSTRUCTIONS : USER_INSTRUCTIONS,
    },
  );

  if (authz.kind === "user") {
    server.registerTool(
      "list_projects",
      {
        title: "List your projects",
        description:
          "Every team + project your Wrightful account can read. Call this first — the other tools take these team/project slugs as arguments.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () =>
        jsonResult({ projects: await listUserProjects(authz.userId) }),
    );
  }

  registerScopedTool(server, authz, {
    name: "list_runs",
    title: "List test runs",
    description:
      "List the project's test runs, newest first. Filter by PR number, commit SHA (prefix ok), branch, status, environment, actor, or date range — e.g. pr:123 + status:[\"failed\"] finds a PR's failing runs. Returns run summaries (pass/fail counts, VCS context) with ids for list_tests/get_run.",
    inputSchema: {
      status: z
        .array(z.enum(RUN_STATUSES))
        .optional()
        .describe('Only runs with these statuses, e.g. ["failed", "flaky"]'),
      branch: z.string().optional().describe("Exact branch name"),
      pr: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("GitHub/GitLab pull-request number"),
      commit: COMMIT_ARG.optional().describe(
        "Commit SHA or prefix (short SHAs fine)",
      ),
      environment: z.string().optional().describe("Exact environment name"),
      actor: z.string().optional().describe("Exact CI actor/user"),
      from: ISO_DATE_ARG.optional().describe("Earliest run date (UTC)"),
      to: ISO_DATE_ARG.optional().describe("Latest run date (UTC)"),
      origin: z
        .enum(RUN_ORIGIN_FILTERS)
        .optional()
        .describe(
          'Run provenance: "ci" (default) hides synthetic monitor runs, "synthetic" shows only them, "all" shows both',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Page size (default 20)"),
      cursor: z
        .string()
        .optional()
        .describe("Opaque nextCursor from the previous page"),
    },
    run: async (scope, args) => {
      const filters: RunsFilters = {
        ...EMPTY_FILTERS,
        status: args.status ?? [],
        branch: args.branch ? [args.branch] : [],
        actor: args.actor ? [args.actor] : [],
        environment: args.environment ? [args.environment] : [],
        origin: args.origin ?? "ci",
        from: args.from ?? null,
        to: args.to ?? null,
        pr: args.pr ?? null,
        commit: args.commit ?? null,
      };
      const page = await loadRunsListPage(scope, filters, {
        cursor: args.cursor ?? null,
        limit: args.limit ?? 20,
      });
      return jsonResult({
        runs: page.runs.map((run) => ({
          ...run,
          url: runUrl(scope, run.id),
        })),
        nextCursor: page.nextCursor,
      });
    },
  });

  registerScopedTool(server, authz, {
    name: "get_run",
    title: "Get a run",
    description:
      "Full summary of one test run: status, pass/fail/flaky/skipped counts, duration, branch/commit/PR/actor context. Use list_tests for the run's individual tests.",
    inputSchema: {
      run_id: z.string().describe("Run id from list_runs"),
    },
    run: async (scope, args) => {
      const run = await loadMcpRun(scope, args.run_id);
      if (!run) return errorResult(`Run not found: ${args.run_id}`);
      return jsonResult({ ...run, url: runUrl(scope, run.id) });
    },
  });

  registerScopedTool(server, authz, {
    name: "list_tests",
    title: "List a run's tests",
    description:
      'Test results of one run, newest first, each with a truncated error message. Pass status:"failed" to see only failures (also: passed, flaky, skipped, timedout). Use get_test_result for full errors, retry attempts, and artifacts.',
    inputSchema: {
      run_id: z.string().describe("Run id from list_runs"),
      status: z
        .enum(["passed", "failed", "flaky", "skipped", "timedout", "queued"])
        .optional()
        .describe("Only tests with this status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Page size (default 100)"),
      cursor: z
        .string()
        .optional()
        .describe("Opaque nextCursor from the previous page"),
    },
    run: async (scope, args) => {
      const page = await loadMcpRunTests(scope, args.run_id, {
        status: args.status ?? null,
        limit: args.limit ?? 100,
        cursor: args.cursor ?? null,
      });
      if (!page) return errorResult(`Run not found: ${args.run_id}`);
      return jsonResult({
        tests: page.tests.map((t) => ({
          ...t,
          url: testResultUrl(scope, args.run_id, t.id),
        })),
        nextCursor: page.nextCursor,
        note:
          page.tests.length > 0
            ? `errorMessage is truncated to ${ERROR_MESSAGE_SNIPPET_CHARS} chars — get_test_result returns the full message, stack, attempts, and artifacts.`
            : undefined,
      });
    },
  });

  registerScopedTool(server, authz, {
    name: "list_flaky_tests",
    title: "List flaky tests",
    description:
      "Rank the project's flakiest tests over a recent window (default 14 days) — the entry point for 'find and fix my flaky tests'. A flaky result is one that failed and then passed on retry; flake rate is flaky / (flaky + passed), matching the dashboard's flaky page. Each row carries the latest flaky testResultId: pass it to get_test_result to see every attempt's own error and artifacts (the failing attempt keeps its screenshot/trace even though the retry passed).",
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("Trailing window in days (default 14)"),
      branch: z
        .string()
        .optional()
        .describe("Only count results from runs on this exact branch"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max tests returned, flakiest first (default 20)"),
    },
    run: async (scope, args) => {
      const result = await loadMcpFlakyTests(scope, {
        days: args.days ?? 14,
        branch: args.branch ?? null,
        limit: args.limit ?? 20,
      });
      return jsonResult({
        ...result,
        semantics: FLAKY_RATE_SEMANTICS,
        flakyTests: result.flakyTests.map((t) => ({
          ...t,
          url:
            t.lastFlakyRunId && t.lastFlakyTestResultId
              ? testResultUrl(scope, t.lastFlakyRunId, t.lastFlakyTestResultId)
              : null,
        })),
        note:
          result.flakyTests.length > 0
            ? "Diagnose with get_test_result(lastFlakyTestResultId): it returns every retry attempt with its own error, plus per-attempt artifacts (screenshots/traces of the FAILING attempt)."
            : "No flaky results in the window. Widen `days`, drop the branch filter, or check list_runs — a run must record a retried-then-passed test for it to count as flaky.",
      });
    },
  });

  registerScopedTool(server, authz, {
    name: "diagnose_flaky_tests",
    title: "Diagnose flaky tests",
    description:
      "Investigate the project's top flaky tests over a recent window (default 14 days). Returns explicit sample/failure/retry counters, normalized error-signature groups, representative test-result ids, same-run co-failures, and whether each test passed in the latest completed CI run. This is the primary entry point for proactive flake hunting; use list_flaky_tests for a cheaper ranking-only call.",
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("Trailing window in days (default 14)"),
      branch: z
        .string()
        .optional()
        .describe("Only count results from runs on this exact branch"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max tests diagnosed, flakiest first (default 10)"),
    },
    run: async (scope, args) =>
      jsonResult({
        ...(await loadMcpFlakyDiagnosis(scope, {
          days: args.days ?? 14,
          branch: args.branch ?? null,
          limit: args.limit ?? 10,
        })),
        semantics: FLAKY_DIAGNOSIS_SEMANTICS,
      }),
  });

  registerScopedTool(server, authz, {
    name: "get_test_history",
    title: "Get test history",
    description:
      "Get the newest execution timeline for exactly one selector: stable test_id, exact spec file, or free-text title/file query. Each execution includes commit/branch/PR context, final status and duration, per-attempt status/duration, worker/shard indexes, and a normalized error signature.",
    inputSchema: {
      test_id: z
        .string()
        .optional()
        .describe("Exact stable Playwright test id"),
      file: z
        .string()
        .optional()
        .describe(
          "Exact spec-file path as currently cataloged — a renamed/moved test matches its current path only; use query for fuzzy matching",
        ),
      query: z
        .string()
        .optional()
        .describe("Free-text substring search over test title and file"),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("Trailing window in days (default 30)"),
      branch: z
        .string()
        .optional()
        .describe("Only include runs on this exact branch"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max executions returned, newest first (default 50)"),
    },
    run: async (scope, args) => {
      const candidates: Array<{
        kind: McpTestHistorySelector["kind"];
        value: string | undefined;
      }> = [
        { kind: "testId", value: args.test_id },
        { kind: "file", value: args.file },
        { kind: "query", value: args.query },
      ];
      const provided = candidates.filter(
        (candidate): candidate is McpTestHistorySelector =>
          candidate.value !== undefined && candidate.value.trim() !== "",
      );
      if (provided.length !== 1) {
        return errorResult(
          "Provide exactly one non-empty selector: test_id, file, or query.",
        );
      }
      const result = await loadMcpTestHistory(scope, {
        selector: { kind: provided[0].kind, value: provided[0].value.trim() },
        days: args.days ?? 30,
        branch: args.branch ?? null,
        limit: args.limit ?? 50,
      });
      return jsonResult({
        ...result,
        executions: result.executions.map((execution) => ({
          ...execution,
          runUrl: runUrl(scope, execution.runId),
          url: testResultUrl(scope, execution.runId, execution.testResultId),
        })),
      });
    },
  });

  registerScopedTool(server, authz, {
    name: "get_test_result",
    title: "Get a test result",
    description:
      "Everything about one test result: full error message + stack, every retry attempt with its own error, tags, annotations, VCS context, and the list of artifacts (screenshots, traces, videos, error context) to fetch via get_artifact.",
    inputSchema: {
      test_result_id: z.string().describe("Test result id from list_tests"),
    },
    run: async (scope, args) => {
      const detail = await loadMcpTestResultDetail(scope, args.test_result_id);
      if (!detail) {
        return errorResult(`Test result not found: ${args.test_result_id}`);
      }
      const { result, attempts, tags, annotations, artifacts } = detail;
      return jsonResult({
        ...result,
        errorStack: truncateText(result.errorStack, ERROR_STACK_MAX_CHARS),
        url: testResultUrl(scope, result.runId, result.id),
        attempts: attempts.map((a) => ({
          ...a,
          errorStack: truncateText(a.errorStack, ERROR_STACK_MAX_CHARS),
        })),
        tags,
        annotations,
        artifacts,
        note:
          artifacts.length > 0
            ? "Fetch an artifact with get_artifact(artifact_id). Visual-regression screenshots come in expected/actual/diff triples sharing a snapshotName."
            : undefined,
      });
    },
  });

  registerScopedTool(server, authz, {
    name: "get_artifact",
    title: "Get an artifact",
    description:
      "Fetch one artifact by id (from get_test_result). Small screenshots return inline as an image; small text artifacts (logs, error context) return inline as text. Everything else — Playwright traces, videos, large files — returns a signed download URL (valid 1 hour normally or 8 hours for replayable traces; no auth header needed). Replayable traces also return a self-hosted viewer URL (same-origin — the trace stays on this dashboard) and can be opened locally with `npx playwright show-trace <downloadUrl>`.",
    inputSchema: {
      artifact_id: z.string().describe("Artifact id from get_test_result"),
    },
    run: async (scope, args) => {
      const artifact = await loadMcpArtifact(scope, args.artifact_id);
      if (!artifact) {
        return errorResult(`Artifact not found: ${args.artifact_id}`);
      }
      const { token, expiresInSeconds } =
        await signArtifactDownloadToken(artifact);
      const downloadUrl = `${publicBase()}${signedDownloadHref(artifact.id, token)}`;

      const meta = artifactMeta(artifact, downloadUrl, expiresInSeconds);
      const inline = await inlineArtifact(artifact);
      if ("blocks" in inline) {
        return {
          content: [
            ...inline.blocks,
            { type: "text", text: JSON.stringify(meta, null, 2) },
          ],
        };
      }
      // Not inlined — fold the reason into the metadata card under its key
      // (`warning` when the bytes are gone, `note` when it's a
      // size/content-type decision) and return metadata only.
      meta[inline.key] = inline.reason;
      return jsonResult(meta);
    },
  });

  return server;
}
