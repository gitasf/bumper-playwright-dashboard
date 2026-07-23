import { env } from "void/env";
import { logger } from "void/log";
import { githubAppEnabled } from "@/lib/config";
import { postCheckRunSurface } from "@/lib/github-checks";
import { postPrCommentSurface } from "@/lib/github-pr-comment";
import { resolveGithubRunContext } from "@/lib/github-run-context";
import type { GithubRunContext } from "@/lib/github-run-context";

/**
 * The single production entry point for the two best-effort GitHub run
 * surfaces: the merge-gating **check run** (`@/lib/github-checks`) and the
 * sticky **PR comment** (`@/lib/github-pr-comment`). `completeRun`,
 * `completeShardedRun`, and `finalizeStaleRun` all call this, so every
 * finalize path — including the watchdog's synthetic one — drives the same
 * code. NEVER throws.
 *
 * Resolves the shared context ONCE (one run-row read, one team-scoped
 * installation lookup, one minted token — see `@/lib/github-run-context`,
 * which also documents the confused-deputy authorization boundary), then
 * posts both surfaces in parallel. Each surface wraps its own try/catch +
 * `logger.error`, so a failure in one never suppresses the other; a shared
 * resolution failure (most likely the token mint) is logged once here and
 * skips both.
 */
export async function postGithubRunSurfaces(
  runId: string,
  projectId: string,
): Promise<void> {
  if (!githubAppEnabled(env)) return;
  let context: GithubRunContext | null;
  try {
    context = await resolveGithubRunContext(runId, projectId);
  } catch (err) {
    logger.error("github run-context resolution failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!context) return;

  await Promise.all([
    postCheckRunSurface(context),
    postPrCommentSurface(context),
  ]);
}
