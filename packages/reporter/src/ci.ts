import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// CI environment detection. Reads standard env vars on GitHub Actions,
// GitLab CI, and CircleCI; falls back to a `CI=true` generic case. Commit
// message is read via `git log` because no CI env exposes it consistently.

export interface CIInfo {
  ciProvider: string | null;
  ciBuildId: string | null;
  /**
   * Job-level discriminator within a build (GITHUB_JOB / CI_JOB_NAME). The
   * build id alone is workflow/pipeline-scoped, so without this matrix and
   * parallel jobs would share an idempotency key and merge into one run.
   */
  ciJobName: string | null;
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
    //   1. the head commit's real message — only present locally with a deep
    //      enough checkout (default shallow PR checkout fetches just the merge
    //      commit; deepen it via actions/checkout `fetch-depth: 0` to get this);
    //   2. the PR title from the event payload — always available, human-readable;
    //   3. the bare `git log` (the merge commit) as a last resort.
    const commitMessage =
      (pr.headSha ? readGitCommitMessage(pr.headSha) : null) ??
      pr.title ??
      readGitCommitMessage();
    return {
      ciProvider: "github-actions",
      ciBuildId: process.env.GITHUB_RUN_ID ?? null,
      ciJobName: process.env.GITHUB_JOB ?? null,
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
      ciJobName: process.env.CI_JOB_NAME ?? null,
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
  /** CI job name (e.g. GITHUB_JOB / CI_JOB_NAME). */
  jobName?: string | null;
}

// Mirror of the dashboard's `idempotencyKey` cap (MAX.ID in
// apps/dashboard/src/lib/schemas.ts) — a longer key would 400 the open call.
// Exported so `contract.test.ts` can pin it === the dashboard's MAX.ID.
export const MAX_IDEMPOTENCY_KEY_LENGTH = 1024;

/**
 * Resolve the run's idempotency key. Precedence:
 *   1. `WRIGHTFUL_IDEMPOTENCY_KEY` env override — set by the synthetic-monitor
 *      container to the pre-known `monitorExecutions.id`, so the opened run is
 *      addressable by `(projectId, idempotencyKey === execution.id)` and the
 *      executor can resolve `runId` back from the execution without a handshake.
 *      Used verbatim — never decorated with discriminators.
 *   2. The CI build id (deterministic across re-runs of the same CI job, which
 *      is what lets a re-run recover the same run row), suffixed with the job
 *      name when present. The build id alone is workflow/pipeline-scoped, so
 *      distinct jobs (different suites in one workflow, matrix legs) would
 *      otherwise silently merge into one dashboard run. The job name is stable
 *      across re-runs, so re-run determinism survives the suffix.
 *
 *      Playwright `--shard` is deliberately NOT a discriminator: shards run
 *      slices of ONE suite and must share an idempotency key so the dashboard
 *      merges them into a single run — openRun's duplicate path, the queue
 *      prefill, and completeRun's monotonic cross-shard status merge are all
 *      designed around shards sharing one key.
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
  return parts.join("-").slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}
