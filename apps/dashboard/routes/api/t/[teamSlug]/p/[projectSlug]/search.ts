import { defineHandler } from "void";
import { db, desc } from "void/db";
import { z } from "zod";
import { runs, tests } from "@schema";
import {
  buildRecentRunsWhere,
  buildTestSearchWhere,
} from "@/lib/command-search";
import { resolveProjectApiScope } from "@/lib/tenant-api-scope";

const RUNS_LIMIT = 6;
const TESTS_LIMIT = 8;

export interface CommandSearchRun {
  id: string;
  status: string;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: number;
}

export interface CommandSearchTest {
  testId: string;
  title: string;
  file: string;
}

export interface CommandSearchResponse {
  runs: CommandSearchRun[];
  tests: CommandSearchTest[];
}

/**
 * GET /api/t/:teamSlug/p/:projectSlug/search?q=<term>
 *
 * Session-authed (any project member) search backing the ⌘K command menu
 * (roadmap 4.1c). SESSION scope via `resolveProjectApiScope` — the same
 * `TenantScope` the rest of the dashboard uses, NOT a Bearer key.
 *
 * Two groups, BOTH project-scoped (the WHERE construction lives in
 * `@/lib/command-search`, unit-tested for the scope invariant + escapeLike):
 *   - recent runs by `createdAt` DESC (a blank query still lists recents)
 *   - distinct tests whose `title`/`file` LIKE-match the term (escaped)
 *
 * Project-scopes EVERY query: recent runs AND `runScopeWhere`, the test search
 * ANDs `testResults.projectId`.
 */
export const GET = defineHandler.withValidator({
  // `q` is the typed query param so `void/client#fetch` callers (the ⌘K menu)
  // pass it type-safely; the schema flows into `.void/routes.d.ts`.
  query: z.object({ q: z.string().max(200).optional() }),
})(async (c, { query }) => {
  const ctx = await resolveProjectApiScope(c, "anyMember");
  if (ctx instanceof Response) return ctx;
  const { scope } = ctx;

  const q = (query.q ?? "").trim();

  const [recentRuns, testRows] = await Promise.all([
    db
      .select({
        id: runs.id,
        status: runs.status,
        branch: runs.branch,
        commitSha: runs.commitSha,
        commitMessage: runs.commitMessage,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(buildRecentRunsWhere(scope))
      .orderBy(desc(runs.createdAt))
      .limit(RUNS_LIMIT),
    // One row per test straight from the catalog (identity table) — no GROUP BY
    // to collapse per-run fact rows. Recent-first via `lastSeenAt`.
    db
      .select({
        testId: tests.testId,
        title: tests.title,
        file: tests.file,
      })
      .from(tests)
      .where(buildTestSearchWhere(scope, q))
      // `testId` breaks lastSeenAt ties deterministically — openRun's prefill
      // seeds a whole suite with one identical lastSeenAt, so without it the
      // top-N tied subset is arbitrary and unstable across requests.
      .orderBy(desc(tests.lastSeenAt), tests.testId)
      .limit(TESTS_LIMIT),
  ]);

  const body: CommandSearchResponse = {
    runs: recentRuns,
    tests: testRows.map((r) => ({
      testId: r.testId,
      title: r.title,
      file: r.file,
    })),
  };
  c.header("Cache-Control", "private, max-age=15");
  return body;
});
