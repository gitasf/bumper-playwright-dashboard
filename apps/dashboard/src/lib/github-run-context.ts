import { and, db, eq } from "void/db";
import { env } from "void/env";
import { githubInstallations, projects, runs, teams } from "@schema";
import { mintInstallationToken } from "@/lib/github-app";
import { parseRepoOwner } from "@/lib/github-http";
import { makeTenantScope } from "@/lib/scope";
import type { TenantScope } from "@/lib/scope";

/**
 * Everything both GitHub run surfaces — the merge-gating check run
 * (`@/lib/github-checks`) and the sticky PR comment (`@/lib/github-pr-comment`)
 * — need for a completed run, resolved once by `postGithubRunSurfaces`
 * (`@/lib/github-run-surfaces`): the run row fields both surfaces render
 * (plus `prNumber`/`branch`/`createdAt` for the PR-comment diff baseline),
 * the canonical run URL, the tenant scope, and a minted installation token.
 */
export interface GithubRunContext {
  runId: string;
  projectId: string;
  teamId: string;
  repo: string;
  commitSha: string | null;
  prNumber: number | null;
  branch: string | null;
  createdAt: number;
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  durationMs: number;
  githubCheckRunId: number | null;
  runUrl: string;
  scope: TenantScope;
  token: string;
}

/**
 * Resolve the shared {@link GithubRunContext} for `runId`, or `null` when
 * there is nothing to post: the run has no `repo`, has neither a commit sha
 * nor a PR number (no surface could attach to it), or no installation OWNED
 * BY THE RUN'S TEAM matches the repo owner. Cheap in the null case — no
 * token is minted.
 *
 * The installation lookup is scoped to `run.teamId` (not the repo-owner
 * string alone) on purpose — this is the confused-deputy security boundary
 * for BOTH surfaces: `run.repo` is attacker-controlled ingest input, so a
 * by-owner-only lookup would let any tenant name another org's repo and make
 * us mint THAT org's installation token to post a (merge-gating) check run or
 * PR comment on their repositories. Requiring the installation to belong to
 * the run's own team means a team can only post GitHub surfaces for an org IT
 * has connected. (`accountLogin` is globally unique, so the team predicate
 * narrows an otherwise-unique point seek down to "our installation or none" —
 * it's the authorization boundary, not a performance concern.)
 *
 * `projectId` is ANDed into every `runs` predicate below, per the
 * `runByIdWhere` convention (`@/lib/scope.ts`) — a caller passing a foreign
 * project's id finds nothing rather than falling through to another team's
 * run.
 *
 * The token is minted here, before either surface's claim decision, so one
 * mint covers both surfaces; the 120s claim TTLs comfortably cover it.
 * THROWS on a genuine failure (a DB error, or `mintInstallationToken`
 * failing) — the caller owns the error envelope.
 */
export async function resolveGithubRunContext(
  runId: string,
  projectId: string,
): Promise<GithubRunContext | null> {
  const rows = await db
    .select({
      teamId: runs.teamId,
      repo: runs.repo,
      commitSha: runs.commitSha,
      prNumber: runs.prNumber,
      branch: runs.branch,
      createdAt: runs.createdAt,
      teamSlug: teams.slug,
      projectSlug: projects.slug,
      status: runs.status,
      passed: runs.passed,
      failed: runs.failed,
      flaky: runs.flaky,
      skipped: runs.skipped,
      totalTests: runs.totalTests,
      durationMs: runs.durationMs,
      githubCheckRunId: runs.githubCheckRunId,
    })
    .from(runs)
    .innerJoin(teams, eq(teams.id, runs.teamId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
    .limit(1);
  const row = rows[0];
  if (!row?.repo) return null;
  if (!row.commitSha && row.prNumber == null) return null;

  const owner = parseRepoOwner(row.repo);
  if (!owner) return null;

  const installRows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.teamId, row.teamId),
        eq(githubInstallations.accountLogin, owner),
      ),
    )
    .limit(1);
  const installationId = installRows[0]?.installationId;
  if (!installationId) return null;

  const token = await mintInstallationToken(installationId);

  const { teamSlug, projectSlug, ...run } = row;
  return {
    ...run,
    repo: row.repo,
    runId,
    projectId,
    runUrl: `${env.WRIGHTFUL_PUBLIC_URL}/t/${teamSlug}/p/${projectSlug}/runs/${runId}`,
    scope: makeTenantScope({
      teamId: row.teamId,
      projectId,
      teamSlug,
      projectSlug,
    }),
    token,
  };
}
