import { and, db, eq, inArray, isNull, lt, or } from "void/db";
import { logger } from "void/log";
import { ulid } from "ulid";
import { githubPrComments, testResults } from "@schema";
import { changedRows } from "@/lib/db/batch";
import { githubFetch } from "@/lib/github-http";
import type { GithubRunContext } from "@/lib/github-run-context";
import {
  runHeadline,
  runSummaryTable,
  statusToConclusion,
} from "@/lib/github-run-render";
import { githubWriteId, postWithWriteMutex } from "@/lib/github-surface-post";
import { computeRunDiff, resolveBaseRun, verdictOf } from "@/lib/runs/diff";
import type { RunDiff } from "@/lib/runs/diff";
import { TERMINAL_RUN_STATUSES } from "@/lib/schemas";
import { childByRunWhere } from "@/lib/scope";

/** Upserts the App-posted run summary into one comment per project and PR. */

// The claim column is a write MUTEX held across content-build + POST/PATCH
// (see postWithWriteMutex): the TTL must outlive that whole sequence.
const PR_COMMENT_CLAIM_TTL_SECONDS = 120;

// A losing writer's bounded wait for the mutex. The holder's content build +
// comment write normally completes well inside one retry delay, so the total
// (attempts - 1) * delay ≈ 4.5s only accrues against a crashed holder's
// unexpired claim.
const PR_COMMENT_MUTEX_ATTEMPTS = 4;
const PR_COMMENT_MUTEX_RETRY_MS = 1500;

const MAX_LISTED_TESTS = 10;

/** Marker distinct from the reporter fallback and scoped to one project. */
export function prCommentMarker(projectId: string): string {
  return `<!-- wrightful:pr-summary:${projectId} -->`;
}

export interface PrCommentTestLine {
  title: string;
  file: string;
  testResultId: string | null;
}

export interface PrCommentContent {
  projectId: string;
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  runUrl: string;
  commitSha: string | null;
  hasBase: boolean;
  baseCommitSha: string | null;
  newFailures: PrCommentTestLine[];
  knownFailures: PrCommentTestLine[];
  flakyTests: PrCommentTestLine[];
}

/** Escape user-authored titles for Markdown link text. */
function escapeMdLinkText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([\\[\]`])/g, "\\$1")
    .trim();
}

/**
 * Sanitize untrusted ingest text for a Markdown inline code span. Backslash
 * escapes don't work inside code spans, so backticks are STRIPPED rather than
 * escaped, and whitespace runs (git permits newlines in path components)
 * collapse to one space — otherwise a hostile filename or commit sha could
 * close the span and inject arbitrary Markdown (mentions, links) into the
 * App-posted comment.
 */
function mdCodeSpanText(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function testListLines(
  tests: readonly PrCommentTestLine[],
  runUrl: string,
): string[] {
  const lines = tests.slice(0, MAX_LISTED_TESTS).map((t) => {
    const label = escapeMdLinkText(t.title);
    const linked = t.testResultId
      ? `[${label}](${runUrl}/tests/${t.testResultId})`
      : label;
    return `- ${linked} — \`${mdCodeSpanText(t.file)}\``;
  });
  if (tests.length > MAX_LISTED_TESTS) {
    lines.push(`- …and ${tests.length - MAX_LISTED_TESTS} more`);
  }
  return lines;
}

function sectionLines(
  heading: string,
  note: string,
  tests: readonly PrCommentTestLine[],
  runUrl: string,
): string[] {
  if (tests.length === 0) return [];
  return [
    "",
    `**${heading} (${tests.length})** — ${note}`,
    "",
    ...testListLines(tests, runUrl),
  ];
}

export function buildPrCommentBody(content: PrCommentContent): string {
  const conclusion = statusToConclusion(content.status);
  const emoji =
    conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⚪";

  const lines = [
    prCommentMarker(content.projectId),
    `### ${emoji} Wrightful — ${runHeadline(content)}`,
    "",
    ...runSummaryTable(content),
    ...(content.hasBase
      ? [
          ...sectionLines(
            "New failures",
            "passing on the base run, failing here",
            content.newFailures,
            content.runUrl,
          ),
          ...sectionLines(
            "Still failing",
            "already failing on the base run",
            content.knownFailures,
            content.runUrl,
          ),
        ]
      : sectionLines(
          "Failures",
          "no baseline run to compare against",
          content.newFailures,
          content.runUrl,
        )),
    ...sectionLines(
      "Flaky",
      "passed only after retry",
      content.flakyTests,
      content.runUrl,
    ),
    "",
    `[View run report →](${content.runUrl})` +
      (content.hasBase ? ` · [Compare to base →](${content.runUrl}/diff)` : ""),
  ];
  if (content.commitSha) {
    // Shas are ingest-validated for length only, so they get the same
    // code-span sanitization as filenames (sanitize BEFORE slicing, so a
    // stripped backtick can't shorten the displayed prefix).
    const baseSha = content.baseCommitSha
      ? mdCodeSpanText(content.baseCommitSha).slice(0, 7)
      : null;
    const baseSuffix = baseSha ? ` · Base: \`${baseSha}\`` : "";
    lines.push(
      "",
      `_Commit: \`${mdCodeSpanText(content.commitSha).slice(0, 7)}\`${baseSuffix}_`,
    );
  }
  return lines.join("\n");
}

/** Build an issue-comment path without trusting the ingested repository name. */
export function buildIssueCommentPath(
  repo: string,
  prNumber: number,
  existingCommentId: number | null,
): string {
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  return existingCommentId
    ? `/repos/${encodedRepo}/issues/comments/${existingCommentId}`
    : `/repos/${encodedRepo}/issues/${prNumber}/comments`;
}

const LISTED_STATUSES = ["failed", "timedout", "interrupted", "flaky"];

interface ListedResultRow {
  id: string;
  testId: string;
  title: string;
  file: string;
  status: string;
}

function toLine(row: ListedResultRow): PrCommentTestLine {
  return { title: row.title, file: row.file, testResultId: row.id };
}

function byFileTitle(a: PrCommentTestLine, b: PrCommentTestLine): number {
  return a.file.localeCompare(b.file) || a.title.localeCompare(b.title);
}

/** Bucket failures and flakes into the rendered comment sections. */
export function bucketListedResults(
  rows: readonly ListedResultRow[],
  diff: RunDiff | null,
): Pick<PrCommentContent, "newFailures" | "knownFailures" | "flakyTests"> {
  const flakyTests = rows
    .filter((r) => r.status === "flaky")
    .map(toLine)
    .sort(byFileTitle);
  const failingRows = rows.filter((r) => verdictOf(r.status) === "failing");

  if (!diff) {
    return {
      newFailures: failingRows.map(toLine).sort(byFileTitle),
      knownFailures: [],
      flakyTests,
    };
  }

  const byTestId = new Map(rows.map((r) => [r.testId, r]));
  const lookup = (testIds: readonly string[]): PrCommentTestLine[] =>
    testIds
      .map((id) => byTestId.get(id))
      .filter((r): r is ListedResultRow => r !== undefined)
      .map(toLine)
      .sort(byFileTitle);

  return {
    newFailures: lookup([
      ...diff.newlyFailed.map((c) => c.testId),
      ...diff.addedTests
        .filter((a) => verdictOf(a.status) === "failing")
        .map((a) => a.testId),
    ]),
    knownFailures: lookup(diff.stillFailing.map((c) => c.testId)),
    flakyTests,
  };
}

/** Find or create the row protected by the project/repository/PR unique index. */
async function ensureStickyRow(
  projectId: string,
  repo: string,
  prNumber: number,
  nowSeconds: number,
): Promise<string | null> {
  await db
    .insert(githubPrComments)
    .values({
      id: ulid(),
      projectId,
      repo,
      prNumber,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    })
    .onConflictDoNothing();
  const rows = await db
    .select({ id: githubPrComments.id })
    .from(githubPrComments)
    .where(
      and(
        eq(githubPrComments.projectId, projectId),
        eq(githubPrComments.repo, repo),
        eq(githubPrComments.prNumber, prNumber),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Claim the sticky comment's write mutex while no live claim exists. */
async function claimPrCommentSlot(
  rowId: string,
  projectId: string,
  nowSeconds: number,
): Promise<number | null> {
  const result = await db
    .update(githubPrComments)
    .set({ claimedAt: nowSeconds, updatedAt: nowSeconds })
    .where(
      and(
        eq(githubPrComments.id, rowId),
        eq(githubPrComments.projectId, projectId),
        or(
          isNull(githubPrComments.claimedAt),
          lt(
            githubPrComments.claimedAt,
            nowSeconds - PR_COMMENT_CLAIM_TTL_SECONDS,
          ),
        ),
      ),
    );
  return changedRows(result) === 1 ? nowSeconds : null;
}

/**
 * Find an existing marker comment on the PR — recovery for an initial POST
 * whose 2xx response was lost in transit (timeout / dropped connection): the
 * comment landed on GitHub but its id was never persisted, so a blind retry
 * would create a duplicate. Mirrors the reporter's `findExistingComment`:
 * one page of 100 comments; the sticky comment is created by the PR's first
 * completed run, so it sits near the top of the (oldest-first) listing — a
 * PR with 100+ comments before any run completed forgoes recovery rather
 * than paginating forever. Unlike the reporter this THROWS on a failed
 * listing instead of falling through to POST: the scan exists to prevent
 * duplicates, and the flaky-network conditions that break the listing are
 * exactly the ones that lose POST responses. The claim releases and the next
 * completed run retries.
 */
async function findMarkerComment(
  token: string,
  repo: string,
  prNumber: number,
  marker: string,
): Promise<number | null> {
  const response = await githubFetch(
    `${buildIssueCommentPath(repo, prNumber, null)}?per_page=100`,
    { method: "GET" },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub PR-comment list failed: ${response.status} ${response.statusText}`,
    );
  }
  const comments = (await response.json().catch(() => [])) as {
    id?: number;
    body?: string;
  }[];
  if (!Array.isArray(comments)) return null;
  for (const c of comments) {
    if (typeof c.id === "number" && c.body?.includes(marker)) return c.id;
  }
  return null;
}

/** PATCH the recorded comment; null when it 404s (comment was deleted). */
async function patchComment(
  token: string,
  repo: string,
  prNumber: number,
  body: string,
  commentId: number,
): Promise<number | null> {
  const response = await githubFetch(
    buildIssueCommentPath(repo, prNumber, commentId),
    { method: "PATCH", body: JSON.stringify({ body }) },
    token,
  );
  if (response.ok) {
    const json = (await response.json().catch(() => ({}))) as { id?: number };
    return json.id ?? commentId;
  }
  if (response.status !== 404) {
    throw new Error(
      `GitHub PR-comment PATCH failed: ${response.status} ${response.statusText}`,
    );
  }
  return null;
}

/** Update the sticky comment, recreating it if the recorded comment was deleted. */
async function postComment(
  token: string,
  repo: string,
  prNumber: number,
  projectId: string,
  body: string,
  existingCommentId: number | null,
): Promise<number | null> {
  if (existingCommentId !== null) {
    const patched = await patchComment(
      token,
      repo,
      prNumber,
      body,
      existingCommentId,
    );
    if (patched !== null) return patched;
  } else {
    // No recorded id does NOT mean no comment: an earlier initial POST's 2xx
    // can have been lost in transit. Adopt an existing marker comment rather
    // than create a duplicate.
    const recovered = await findMarkerComment(
      token,
      repo,
      prNumber,
      prCommentMarker(projectId),
    );
    if (recovered !== null) {
      const patched = await patchComment(
        token,
        repo,
        prNumber,
        body,
        recovered,
      );
      if (patched !== null) return patched;
    }
  }
  return githubWriteId(
    buildIssueCommentPath(repo, prNumber, null),
    "POST",
    { body },
    token,
    "PR-comment",
  );
}

/**
 * Assemble a completed run's PR-comment content from an already-resolved
 * {@link GithubRunContext}. Uses the previous TERMINAL run (not just the
 * diff page's last-*passed* run) as the diff baseline, via
 * `resolveBaseRun(..., { statuses: TERMINAL_RUN_STATUSES })`, so a failure
 * already present on the previous push's run classifies as known rather than
 * reading as new. The baseline is scoped to THIS `(repo, prNumber)` — branch
 * names are not unique across PRs (two fork PRs can both report head ref
 * `fix`), so a branch-wide pick could adopt an unrelated PR's run and
 * mislabel its failures as known-vs-new.
 */
async function buildContent(
  context: GithubRunContext,
  repo: string,
  prNumber: number,
): Promise<PrCommentContent> {
  const { scope, runId } = context;
  const base = await resolveBaseRun(
    scope,
    { id: runId, branch: context.branch, createdAt: context.createdAt },
    { statuses: TERMINAL_RUN_STATUSES, pr: { repo, prNumber } },
  );
  const [diff, listedRows] = await Promise.all([
    computeRunDiff(scope, runId, base),
    db
      .select({
        id: testResults.id,
        testId: testResults.testId,
        title: testResults.title,
        file: testResults.file,
        status: testResults.status,
      })
      .from(testResults)
      .where(
        and(
          childByRunWhere(testResults, scope, runId),
          inArray(testResults.status, LISTED_STATUSES),
        ),
      ),
  ]);
  return {
    projectId: context.projectId,
    status: context.status,
    passed: context.passed,
    failed: context.failed,
    flaky: context.flaky,
    skipped: context.skipped,
    durationMs: context.durationMs,
    runUrl: context.runUrl,
    commitSha: context.commitSha,
    hasBase: base !== null,
    baseCommitSha: base?.commitSha ?? null,
    ...bucketListedResults(listedRows, diff),
  };
}

/**
 * Post/update the sticky PR comment for a resolved {@link GithubRunContext}.
 * Best-effort: NEVER throws — it logs and swallows its own errors, so a
 * GitHub outage neither fails ingest nor suppresses the sibling check-run
 * surface (see `postGithubRunSurfaces`). No-ops when the run has no
 * `prNumber` (nothing to comment on).
 *
 * The comment is ONE GitHub resource shared by every run on the PR, so all
 * writes go through `postWithWriteMutex`: concurrent completions serialize on
 * the row's claim column, and the persisted `runId` (ULIDs — lexicographic
 * order == creation order) is the monotonic guard that stops an older
 * finalize from overwriting a newer run's summary, at GitHub as well as in
 * the DB.
 */
export async function postPrCommentSurface(
  context: GithubRunContext,
): Promise<void> {
  const { runId, projectId, repo, prNumber } = context;
  try {
    if (!repo || prNumber == null) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const stickyId = await ensureStickyRow(
      projectId,
      repo,
      prNumber,
      nowSeconds,
    );
    if (stickyId === null) return;

    await postWithWriteMutex(
      "pr-comment",
      runId,
      {
        read: async () => {
          const rows = await db
            .select({
              id: githubPrComments.commentId,
              runId: githubPrComments.runId,
            })
            .from(githubPrComments)
            .where(
              and(
                eq(githubPrComments.id, stickyId),
                eq(githubPrComments.projectId, projectId),
              ),
            )
            .limit(1);
          return rows[0] ?? { id: null, runId: null };
        },
        claim: (now) => claimPrCommentSlot(stickyId, projectId, now),
        release: async (claim) => {
          await db
            .update(githubPrComments)
            .set({ claimedAt: null })
            .where(
              and(
                eq(githubPrComments.id, stickyId),
                eq(githubPrComments.claimedAt, claim),
              ),
            );
        },
        persist: async (id, claim) => {
          await db
            .update(githubPrComments)
            .set({
              commentId: id,
              runId,
              claimedAt: null,
              updatedAt: nowSeconds,
            })
            .where(
              and(
                eq(githubPrComments.id, stickyId),
                eq(githubPrComments.claimedAt, claim),
              ),
            );
        },
      },
      async (existingId) => {
        const body = buildPrCommentBody(
          await buildContent(context, repo, prNumber),
        );
        return postComment(
          context.token,
          repo,
          prNumber,
          projectId,
          body,
          existingId,
        );
      },
      {
        attempts: PR_COMMENT_MUTEX_ATTEMPTS,
        retryDelayMs: PR_COMMENT_MUTEX_RETRY_MS,
      },
    );
  } catch (err) {
    logger.error("github pr-comment post failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
