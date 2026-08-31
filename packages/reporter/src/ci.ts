import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ShardInfo } from "./types.js";

// CI environment detection. Reads standard env vars on GitHub Actions,
// GitLab CI, and CircleCI; falls back to a `CI=true` generic case. Commit
// message is read via `git log` because no CI env exposes it consistently.

export interface CIInfo {
  ciProvider: string | null;
  ciBuildId: string | null;
  /**
   * Job-level discriminator within a build (GITHUB_JOB /
   * CI_JOB_GROUP_NAME-or-CI_JOB_NAME). The build id alone is
   * workflow/pipeline-scoped, so without this independent jobs would share an
   * idempotency key and merge into one run.
   */
  ciJobName: string | null;
  /**
   * Provider execution attempt shared by every job/shard in one rerun. GitHub's
   * GITHUB_RUN_ATTEMPT increments when a workflow is rerun, so a new execution
   * never reuses and mutates the previous dashboard run.
   */
  ciRunAttempt: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  repo: string | null;
  actor: string | null;
}

// Field-length caps mirrored from the dashboard's wire schema (MAX in
// apps/dashboard/src/lib/schemas.ts). These identity fields *reject* (not
// truncate) on oversize, and a 400 on the open-run call is non-retryable — it
// loses the whole run (index.ts disables streaming). Applied once in
// `clampFields` rather than per-branch. Exported so contract.test.ts can pin
// them === the dashboard's MAX.
export const MAX_SHORT_FIELD_LENGTH = 256;
export const MAX_NAME_FIELD_LENGTH = 1024;

function clamp(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

// Single choke point for the wire caps: every detectCI() result flows through
// here, so no provider branch (current or future) can ship an oversized field.
// Listed fields are the ones sourced from env/payload; the rest are intentionally
// uncapped — commitMessage truncates server-side, ciJobName/prNumber aren't
// length-bound, ciProvider is a constant.
function clampFields(info: CIInfo): CIInfo {
  return {
    ...info,
    ciBuildId: clamp(info.ciBuildId, MAX_SHORT_FIELD_LENGTH),
    commitSha: clamp(info.commitSha, MAX_SHORT_FIELD_LENGTH),
    branch: clamp(info.branch, MAX_NAME_FIELD_LENGTH),
    repo: clamp(info.repo, MAX_NAME_FIELD_LENGTH),
    actor: clamp(info.actor, MAX_NAME_FIELD_LENGTH),
  };
}

// A git object name: hex, 7 (abbreviated) to 64 (full sha-256) chars. Used to
// validate the PR head sha from the (attacker-influenceable on forks) event
// payload before it reaches `git log` as an argument. A hex string can't be
// mistaken for a git option (no leading `-`), which closes the argument-
// injection vector — `git log --pretty=%B --output=…` would otherwise let a
// crafted `head.sha` write to an arbitrary file. (A `--` separator is NOT a fix
// here: `git log … -- <sha>` treats <sha> as a pathspec, not a revision.)
const GIT_OBJECT_NAME = /^[0-9a-f]{7,64}$/i;

function readGitCommitMessage(ref?: string): string | null {
  try {
    const args = ["log", "-1", "--pretty=%B"];
    if (ref) args.push(ref);
    const msg = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    // `|| null` is load-bearing: detectCI()'s `??` message-precedence chain
    // relies on an empty/whitespace-only commit message being nullish so it
    // falls through to the PR title rather than emitting "".
    return msg || null;
  } catch {
    return null;
  }
}

// GitHub writes `Merge <sha> into <sha>` for the merge its "Update branch"
// button pushes onto the PR head, so even the head sha's own message — the best
// source for a hand-written commit — can be two bare object ids and nothing
// else. That says strictly less than the branch / PR / sha shown beside it, so
// it loses to the PR title in detectCIRaw. No `/m` flag and matched against the
// whole message, so `$` also rejects anything with a body: a merge someone did
// write a message for keeps it.
const GENERATED_MERGE_MESSAGE = /^Merge [0-9a-f]{7,64} into [0-9a-f]{7,64}$/i;

// `prNumber` is `z.number().int().min(0)` on the wire — NaN, negatives, and
// non-integers all *reject* (NaN because `z.number()` rejects it), 400-ing the
// open call. Funnel every PR-number source (parseInt results, payload JSON)
// through this so a junk CI var or hostile payload degrades to null.
function safePrNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parsePrNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  return safePrNumber(parseInt(raw, 10));
}

interface GithubPullRequest {
  number: number | null;
  /**
   * The PR's head commit — the commit the author actually wrote. On
   * `pull_request*` events GITHUB_SHA and the checked-out HEAD point at an
   * ephemeral merge commit ("Merge <head> into <base>") instead, so we read the
   * head sha from the event payload to recover the real commit identity.
   */
  headSha: string | null;
  /**
   * The PR title. The event payload never carries the head commit's *message*,
   * so when the head commit object isn't present locally (the default shallow
   * PR checkout) this is the only human-readable string available — used as the
   * commit-message fallback ahead of the useless merge-commit message.
   */
  title: string | null;
}

// Skip an implausibly large event file rather than read it into memory. GitHub
// caps webhook payloads at 25 MiB and the path is runner-controlled, so this
// only fires on a corrupt/pathological file.
const MAX_EVENT_FILE_BYTES = 25 * 1024 * 1024;

function readGithubPullRequest(): GithubPullRequest {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const empty = { number: null, headSha: null, title: null };
  if (!eventPath) return empty;
  try {
    if (statSync(eventPath).size > MAX_EVENT_FILE_BYTES) return empty;
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: {
        number?: number;
        title?: string;
        head?: { sha?: string };
      };
    };
    const headSha = event.pull_request?.head?.sha;
    const title = event.pull_request?.title;
    return {
      number: safePrNumber(event.pull_request?.number),
      headSha:
        typeof headSha === "string" && GIT_OBJECT_NAME.test(headSha)
          ? headSha
          : null,
      title: typeof title === "string" && title.trim() ? title.trim() : null,
    };
  } catch {
    return empty;
  }
}

function githubPrNumber(pr: GithubPullRequest): number | null {
  const ref = process.env.GITHUB_REF;
  const match = ref?.match(/^refs\/pull\/(\d+)\/merge$/);
  if (match) return safePrNumber(parseInt(match[1], 10));
  // `pull_request_target` events don't get a refs/pull/N/merge ref; recover the
  // number from the event payload instead. (push / merge_group /
  // workflow_dispatch events carry no `pull_request`, so this stays null.)
  return pr.number;
}

function circlePrNumber(): number | null {
  const fromEnv = parsePrNumber(process.env.CIRCLE_PR_NUMBER);
  if (fromEnv !== null) return fromEnv;
  const url = process.env.CIRCLE_PULL_REQUEST;
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)$/);
  return match ? safePrNumber(parseInt(match[1], 10)) : null;
}

export function detectCI(): CIInfo | null {
  const info = detectCIRaw();
  return info ? clampFields(info) : null;
}

function detectCIRaw(): CIInfo | null {
  if (process.env.GITHUB_ACTIONS === "true") {
    const pr = readGithubPullRequest();
    // On `pull_request*` events GITHUB_SHA and the checked-out HEAD are an
    // ephemeral merge commit ("Merge <head> into <base>"), not the commit the
    // PR author wrote. Prefer the head sha from the event payload, and resolve
    // the message in descending order of fidelity:
    //   1. the head commit's message, when a human wrote it — only present
    //      locally with a deep enough checkout (default shallow PR checkout
    //      fetches just the merge commit; deepen it via actions/checkout
    //      `fetch-depth: 0` to get this);
    //   2. the PR title from the event payload — always available, human-readable;
    //   3. a head commit message GitHub generated (see GENERATED_MERGE_MESSAGE)
    //      — beats nothing, but a PR title beats it;
    //   4. the bare `git log` (the merge commit) as a last resort.
    const head = pr.headSha ? readGitCommitMessage(pr.headSha) : null;
    const authored = head && !GENERATED_MERGE_MESSAGE.test(head) ? head : null;
    const commitMessage =
      authored ?? pr.title ?? head ?? readGitCommitMessage();
    return {
      ciProvider: "github-actions",
      ciBuildId: process.env.GITHUB_RUN_ID ?? null,
      ciJobName: process.env.GITHUB_JOB ?? null,
      ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      branch:
        process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
      commitSha: pr.headSha ?? process.env.GITHUB_SHA ?? null,
      commitMessage,
      prNumber: githubPrNumber(pr),
      repo: process.env.GITHUB_REPOSITORY ?? null,
      actor:
        process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || null,
    };
  }
  if (process.env.GITLAB_CI === "true") {
    return {
      ciProvider: "gitlab-ci",
      ciBuildId: process.env.CI_PIPELINE_ID ?? null,
      // Parallel GitLab jobs expand CI_JOB_NAME per instance, which would give
      // each native Playwright shard a different idempotency key.
      // CI_JOB_GROUP_NAME is shared by the group while remaining equal to the
      // ordinary job name outside parallel/grouped jobs.
      ciJobName:
        process.env.CI_JOB_GROUP_NAME || process.env.CI_JOB_NAME || null,
      ciRunAttempt: null,
      branch:
        process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ||
        process.env.CI_COMMIT_BRANCH ||
        null,
      commitSha: process.env.CI_COMMIT_SHA ?? null,
      commitMessage: process.env.CI_COMMIT_MESSAGE || readGitCommitMessage(),
      prNumber: parsePrNumber(process.env.CI_MERGE_REQUEST_IID),
      repo: process.env.CI_PROJECT_PATH ?? null,
      actor: process.env.GITLAB_USER_LOGIN ?? null,
    };
  }
  if (process.env.CIRCLECI === "true") {
    return {
      ciProvider: "circleci",
      ciBuildId: process.env.CIRCLE_WORKFLOW_ID ?? null,
      ciJobName: process.env.CIRCLE_JOB ?? null,
      ciRunAttempt: null,
      branch: process.env.CIRCLE_BRANCH ?? null,
      commitSha: process.env.CIRCLE_SHA1 ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: circlePrNumber(),
      repo:
        process.env.CIRCLE_PROJECT_USERNAME &&
        process.env.CIRCLE_PROJECT_REPONAME
          ? `${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}`
          : null,
      actor: process.env.CIRCLE_USERNAME ?? null,
    };
  }
  if (process.env.CI === "true") {
    return {
      ciProvider: "unknown",
      ciBuildId: null,
      ciJobName: null,
      ciRunAttempt: null,
      branch: null,
      commitSha: null,
      commitMessage: readGitCommitMessage(),
      prNumber: null,
      repo: null,
      actor: null,
    };
  }
  return null;
}

export interface IdempotencyDiscriminators {
  /** CI job/group name (e.g. GITHUB_JOB / CI_JOB_GROUP_NAME). */
  jobName?: string | null;
  /** Provider rerun attempt shared by every shard in the execution. */
  runAttempt?: string | null;
  /**
   * Selected Playwright projects. GitHub's GITHUB_JOB is the matrix job id,
   * not its expanded display name, so project matrices otherwise collapse
   * into one run. Every native shard of one suite must receive the same set.
   */
  projectNames?: ReadonlyArray<string | null>;
  /** Explicit discriminator for matrix axes Playwright cannot observe. */
  matrixKey?: string | null;
}

export interface CIExecutionContext {
  /** Whether Playwright is running one slice of a native sharded suite. */
  nativeSharded: boolean;
  /** An orchestrator-supplied key bypasses provider-derived identity. */
  hasExplicitIdempotencyKey: boolean;
}

/**
 * Provider-specific retry policy for one reporter process.
 *
 * Providers expose materially different retry identities. Keeping that
 * translation here prevents the reporter lifecycle from growing a collection
 * of provider conditionals that eventually disagree with key generation.
 */
export type CIExecutionPolicy =
  | {
      status: "ready";
      runAttempt: string | null;
      warning: string | null;
    }
  | {
      status: "blocked";
      reason: string;
    };

export function resolveCIExecutionPolicy(
  ci: CIInfo | null,
  context: CIExecutionContext,
  env: NodeJS.ProcessEnv = process.env,
): CIExecutionPolicy {
  if (context.hasExplicitIdempotencyKey) {
    return { status: "ready", runAttempt: null, warning: null };
  }

  switch (ci?.ciProvider) {
    case "github-actions": {
      const isRerun =
        ci.ciRunAttempt !== null &&
        ci.ciRunAttempt !== "" &&
        ci.ciRunAttempt !== "1";
      if (context.nativeSharded && isRerun) {
        return {
          status: "blocked",
          reason:
            "GitHub Actions cannot tell reporters whether a native-shard rerun includes every shard. " +
            "Streaming this rerun would risk an incomplete dashboard run. Rerun the full workflow with " +
            "WRIGHTFUL_IDEMPOTENCY_KEY set to one new value shared by every shard.",
        };
      }
      return {
        status: "ready",
        runAttempt: ci.ciRunAttempt,
        warning: null,
      };
    }
    case "gitlab-ci":
      if (context.nativeSharded) {
        return {
          status: "ready",
          runAttempt: null,
          warning:
            "GitLab native-shard job retries cannot be identified as one complete retry set. " +
            "Retry the full pipeline instead of an individual shard.",
        };
      }
      // CI_JOB_ID changes when GitLab retries a job, but is stable for all
      // transport retries performed inside that job.
      return {
        status: "ready",
        runAttempt: env.CI_JOB_ID ?? null,
        warning: null,
      };
    default:
      return {
        status: "ready",
        runAttempt: ci?.ciRunAttempt ?? null,
        warning: null,
      };
  }
}

// Mirror of the dashboard's `idempotencyKey` cap (MAX.ID in
// apps/dashboard/src/lib/schemas.ts) — a longer key would 400 the open call.
// Exported so `contract.test.ts` can pin it === the dashboard's MAX.ID.
export const MAX_IDEMPOTENCY_KEY_LENGTH = 1024;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function boundedDerivedKey(parts: string[]): string {
  const raw = parts.join("-");
  if (raw.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return raw;
  // Preserve a digest of every discriminator. Plain slicing can discard the
  // suffix and make two long build ids with different jobs/matrix keys collide.
  const digest = shortHash(raw);
  const prefixLength = MAX_IDEMPOTENCY_KEY_LENGTH - digest.length - 1;
  return `${raw.slice(0, prefixLength)}-${digest}`;
}

/**
 * Resolve the run's idempotency key. Precedence:
 *   1. `WRIGHTFUL_IDEMPOTENCY_KEY` env override — set by the synthetic-monitor
 *      container to the pre-known `monitorExecutions.id`, so the opened run is
 *      addressable by `(projectId, idempotencyKey === execution.id)` and the
 *      executor can resolve `runId` back from the execution without a handshake.
 *      Used verbatim — never decorated with discriminators.
 *   2. The CI build id, suffixed with job, provider run-attempt, selected
 *      Playwright-project set, and any explicit matrix discriminator. A rerun
 *      is a new dashboard execution; retries within one attempt stay
 *      idempotent.
 *
 *      The shard number is deliberately NOT a discriminator: shards run slices
 *      of ONE selected project set and must share an idempotency key so the
 *      dashboard merges them into a single run. The project set remains a
 *      discriminator so independent chromium and firefox shard matrices do
 *      not merge.
 *   3. A random UUID for purely local runs.
 */
export function generateIdempotencyKey(
  ciBuildId: string | null | undefined,
  discriminators: IdempotencyDiscriminators = {},
): string {
  const explicit = process.env.WRIGHTFUL_IDEMPOTENCY_KEY;
  if (explicit) return explicit;
  if (!ciBuildId) return randomUUID();
  const parts = [ciBuildId];
  if (discriminators.jobName) parts.push(discriminators.jobName);
  if (discriminators.runAttempt) {
    parts.push(`attempt-${discriminators.runAttempt}`);
  }
  if (discriminators.projectNames?.length) {
    const projects = [
      ...new Set(discriminators.projectNames.map((p) => p ?? "")),
    ]
      .sort()
      .join("\u0000");
    parts.push(`projects-${shortHash(projects)}`);
  }
  if (discriminators.matrixKey) {
    parts.push(`matrix-${shortHash(discriminators.matrixKey)}`);
  }
  return boundedDerivedKey(parts);
}

/**
 * Shard coordinates for this reporter process: Playwright's own slicing when
 * `--shard` is in play, otherwise an env declaration.
 *
 * `config.shard` is set ONLY by `--shard`, so a matrix that splits a suite by
 * `--project` (or by spec paths, or a grep) looks non-sharded to the reporter
 * even when every leg shares one `WRIGHTFUL_IDEMPOTENCY_KEY` and therefore one
 * dashboard run. Without shard coordinates the dashboard finalizes that run on
 * the FIRST leg's `/complete` — the run goes terminal while the slower legs are
 * still streaming into it, and any leg whose `openRun` lands after that gets
 * `409 ... already belongs to a completed execution` and drops every result it
 * has. Declaring the coordinates puts such a matrix on the native-shard path
 * instead; the README documents the CI wiring.
 *
 * A declaration must be complete and consistent (`1 <= index <= total`).
 * Anything else is a misconfiguration that would strand the run at `running`
 * until the dashboard watchdog sweeps it, so it warns and reports no shard
 * rather than guessing — while a leg that declares nothing at all is the
 * ordinary single-run case and stays silent.
 */
const SHARD_INDEX_ENV = "WRIGHTFUL_SHARD_INDEX";
const SHARD_TOTAL_ENV = "WRIGHTFUL_SHARD_TOTAL";

export interface ShardResolution {
  /** Coordinates for a sharded execution; null for a plain single run. */
  shard: ShardInfo | null;
  /** Misconfiguration to surface on stderr; null when there is nothing to say. */
  warning: string | null;
}

/**
 * Parse one 1-based shard coordinate from an already-trimmed value. The regex
 * rejects anything that isn't a run of digits (a float, a CI expression that
 * never expanded); `isSafeInteger` rejects a digit run too long to survive
 * `Number`; `>= 1` rejects a 0-based index.
 */
function parseShardCoordinate(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export function resolveShardIdentity(
  configShard: { current: number; total: number } | null,
  env: NodeJS.ProcessEnv = process.env,
): ShardResolution {
  const rawIndex = env[SHARD_INDEX_ENV]?.trim() ?? "";
  const rawTotal = env[SHARD_TOTAL_ENV]?.trim() ?? "";
  const declared = rawIndex !== "" || rawTotal !== "";

  if (configShard) {
    return {
      shard: { index: configShard.current, total: configShard.total },
      warning: declared
        ? `${SHARD_INDEX_ENV}/${SHARD_TOTAL_ENV} ignored — Playwright's --shard takes precedence ` +
          `(running shard ${configShard.current}/${configShard.total}).`
        : null,
    };
  }

  if (!declared) return { shard: null, warning: null };

  // One rejection for every bad declaration, echoing both raw values: a half
  // declaration shows up as an empty string, so the same sentence covers the
  // missing variable, the unexpanded expression, and the 0-based index.
  const index = parseShardCoordinate(rawIndex);
  const total = parseShardCoordinate(rawTotal);
  if (index === null || total === null || index > total) {
    return {
      shard: null,
      warning:
        `${SHARD_INDEX_ENV}="${rawIndex}" ${SHARD_TOTAL_ENV}="${rawTotal}" does not address a shard ` +
        `(both must be whole numbers with 1 <= index <= total). Reporting this leg as a whole run.`,
    };
  }

  return { shard: { index, total }, warning: null };
}
