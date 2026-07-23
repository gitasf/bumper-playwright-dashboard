// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

/**
 * DB-integration coverage for the sticky PR-comment surface: the sticky-row
 * find-or-create, write-mutex concurrency (every write — first POST and
 * later PATCHes — serializes on the claim column), the ULID stale-run guard,
 * the PATCH-404 repost, and the end-to-end new-vs-known/flaky content
 * assembled from real `testResults` rows. Runs against in-process pglite on
 * the Node lane, mirroring `github-checks-claim.test.ts` (whose header
 * explains the lane split); the pure rendering/bucketing tests stay in
 * `github-pr-comment.workers.test.ts`.
 */

const h = await vi.hoisted(async () => {
  const schema = await import("@schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return {
    db,
    client: {
      exec: (s: string) => client.exec(s),
      close: () => client.close(),
    },
  };
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

vi.mock("void/env", () => ({
  env: { WRIGHTFUL_PUBLIC_URL: "https://dash.example" },
}));

vi.mock("@/lib/config", () => ({
  githubAppEnabled: () => true,
}));

const mintInstallationToken = vi.fn(async (_installationId: number) =>
  Promise.resolve("token-123"),
);

interface FetchCall {
  method: string;
  path: string;
  body: string | null;
}

let fetchCalls: FetchCall[] = [];
let fetchDelayMs = 15;
let nextCommentId = 900;
let failNextPost = false;
let patchStatus = 200;
/** The GET issue-comments listing the pre-POST marker-recovery scan reads. */
let listedComments: { id: number; body: string }[] = [];

/** POST/PATCH calls — the writes, excluding the marker-recovery GET scans. */
const writeCalls = () => fetchCalls.filter((c) => c.method !== "GET");

// Same seams as the check-run claim test: stub the token mint + `githubFetch`,
// keep the real pure `parseRepoOwner`. The fetch delay keeps the winner's
// write in flight long enough that a concurrent racer reliably loses the
// mutex claim and exercises the wait-and-retry path.
vi.mock("@/lib/github-app", () => ({
  mintInstallationToken,
}));
vi.mock("@/lib/github-http", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/github-http")>(
      "@/lib/github-http",
    );
  return {
    ...actual,
    githubFetch: async (path: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? init.body : null;
      fetchCalls.push({ method, path, body });
      await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
      if (method === "GET") {
        return new Response(JSON.stringify(listedComments), { status: 200 });
      }
      if (method === "POST" && failNextPost) {
        return new Response("boom", {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
      if (method === "PATCH") {
        if (patchStatus !== 200) {
          return new Response("nope", {
            status: patchStatus,
            statusText: "Not Found",
          });
        }
        const id = Number(path.split("/").pop());
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: nextCommentId }), {
        status: 201,
      });
    },
  };
});

const { postPrCommentSurface } = await import("@/lib/github-pr-comment");
const { resolveGithubRunContext } = await import("@/lib/github-run-context");
const {
  githubInstallations,
  githubPrComments,
  projects,
  runs,
  teams,
  testResults,
} = await import("@schema");
const { eq } = await import("void/_db");
const { getTableConfig } = await import("void/schema-pg");
const { resetTables } = await import("./pg-integration/harness");

// Production reaches the surface through `postGithubRunSurfaces`; compose the
// same resolve → post pair directly so these commitSha-bearing fixtures don't
// also fire the check-run surface into the mocked fetch.
async function postPrComment(runId: string, projectId: string): Promise<void> {
  const context = await resolveGithubRunContext(runId, projectId);
  if (context) await postPrCommentSurface(context);
}

const TEAM_ID = "team-1";
const PROJECT_ID = "proj-1";
const PR_NUMBER = 41;

async function seedTeamAndProject() {
  await h.db.insert(teams).values({
    id: TEAM_ID,
    slug: "acme",
    name: "Acme",
    createdAt: 1000,
    // The ad-hoc DDL (createTableSql) carries no column DEFAULTs; set the
    // NOT NULL `tier` explicitly (same note as github-checks-claim.test.ts).
    tier: "free",
  });
  await h.db.insert(projects).values({
    id: PROJECT_ID,
    teamId: TEAM_ID,
    slug: "web",
    name: "Web",
    createdAt: 1000,
  });
  await h.db.insert(githubInstallations).values({
    id: "install-1",
    teamId: TEAM_ID,
    installationId: 42,
    accountLogin: "acme",
    createdAt: 1000,
    updatedAt: 1000,
  });
}

async function seedRun(
  id: string,
  overrides: Partial<typeof runs.$inferInsert> = {},
) {
  await h.db.insert(runs).values({
    id,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    idempotencyKey: id,
    totalTests: 3,
    passed: 2,
    failed: 1,
    flaky: 0,
    skipped: 0,
    durationMs: 100,
    status: "failed",
    repo: "acme/web",
    branch: "feat",
    commitSha: "deadbeef",
    prNumber: PR_NUMBER,
    createdAt: 2000,
    lastActivityAt: 2000,
    completedAt: 2000,
    origin: "ci",
    ...overrides,
  });
}

async function seedResult(
  runId: string,
  testId: string,
  status: string,
  overrides: Partial<typeof testResults.$inferInsert> = {},
) {
  await h.db.insert(testResults).values({
    id: `${runId}:${testId}`,
    projectId: PROJECT_ID,
    runId,
    testId,
    title: `title ${testId}`,
    file: `${testId}.spec.ts`,
    status,
    durationMs: 10,
    retryCount: 0,
    createdAt: 2000,
    updatedAt: 2000,
    ...overrides,
  });
}

interface StickyState {
  id: string;
  commentId: number | null;
  runId: string | null;
  claimedAt: number | null;
}

async function readSticky(): Promise<StickyState | null> {
  const rows = await h.db
    .select({
      id: githubPrComments.id,
      commentId: githubPrComments.commentId,
      runId: githubPrComments.runId,
      claimedAt: githubPrComments.claimedAt,
    })
    .from(githubPrComments)
    .where(eq(githubPrComments.projectId, PROJECT_ID));
  return rows[0] ?? null;
}

async function seedSticky(commentId: number | null, runId: string | null) {
  await h.db.insert(githubPrComments).values({
    id: "sticky-1",
    projectId: PROJECT_ID,
    repo: "acme/web",
    prNumber: PR_NUMBER,
    commentId,
    runId,
    createdAt: 1000,
    updatedAt: 1000,
  });
}

beforeAll(async () => {
  await resetTables(h.client, [
    teams,
    projects,
    githubInstallations,
    runs,
    testResults,
    githubPrComments,
  ]);
  // createTableSql (inside resetTables) emits columns only; the sticky-row
  // find-or-create's racing safety relies on this unique identity, so create
  // it for real.
  await h.client.exec(
    `create unique index "githubPrComments_project_repo_pr_idx"
     on "githubPrComments" ("projectId", "repo", "prNumber");`,
  );
});

afterAll(async () => {
  await h.client.close();
});

beforeEach(async () => {
  const tables = [
    githubPrComments,
    testResults,
    runs,
    githubInstallations,
    projects,
    teams,
  ];
  for (const t of tables) {
    const { name } = getTableConfig(t);
    await h.client.exec(`delete from "${name}";`);
  }
  await seedTeamAndProject();
  fetchCalls = [];
  fetchDelayMs = 15;
  nextCommentId = 900;
  failNextPost = false;
  patchStatus = 200;
  listedComments = [];
  mintInstallationToken.mockClear();
});

describe("postPrCommentSurface (resolved context)", () => {
  it("POSTs a comment on first completion and persists commentId + runId", async () => {
    await seedRun("run-a");
    await seedResult("run-a", "t-1", "failed");

    await postPrComment("run-a", PROJECT_ID);

    // The empty marker-recovery GET precedes the fresh POST.
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(fetchCalls[1]!.path).toBe("/repos/acme/web/issues/41/comments");
    const body = JSON.parse(fetchCalls[1]!.body!) as { body: string };
    expect(body.body).toContain("<!-- wrightful:pr-summary:proj-1 -->");
    // No prior terminal run on the branch → the un-split Failures section.
    expect(body.body).toContain(
      "**Failures (1)** — no baseline run to compare against",
    );
    expect(body.body).toContain(
      "https://dash.example/t/acme/p/web/runs/run-a/tests/run-a:t-1",
    );

    const sticky = await readSticky();
    expect(sticky?.commentId).toBe(900);
    expect(sticky?.runId).toBe("run-a");
    expect(sticky?.claimedAt).toBeNull();
  });

  it("PATCHes the recorded comment for a later run on the same PR, splitting new-vs-known", async () => {
    // Previous push: t-known already failing, t-new passing.
    await seedRun("run-a", { createdAt: 1500 });
    await seedResult("run-a", "t-known", "failed", { id: "run-a:t-known" });
    await seedResult("run-a", "t-new", "passed", { id: "run-a:t-new" });
    // This push: t-known still failing, t-new regressed, t-flaky flaked.
    await seedRun("run-b", { commitSha: "cafef00d", flaky: 1 });
    await seedResult("run-b", "t-known", "failed");
    await seedResult("run-b", "t-new", "failed");
    await seedResult("run-b", "t-flaky", "flaky", { retryCount: 1 });
    await seedSticky(900, "run-a");

    await postPrComment("run-b", PROJECT_ID);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.method).toBe("PATCH");
    expect(fetchCalls[0]!.path).toBe("/repos/acme/web/issues/comments/900");
    const body = (JSON.parse(fetchCalls[0]!.body!) as { body: string }).body;
    expect(body).toContain(
      "**New failures (1)** — passing on the base run, failing here",
    );
    expect(body).toContain("title t-new");
    expect(body).toContain(
      "**Still failing (1)** — already failing on the base run",
    );
    expect(body).toContain("title t-known");
    expect(body).toContain("**Flaky (1)** — passed only after retry");
    expect(body).toContain(
      "[Compare to base →](https://dash.example/t/acme/p/web/runs/run-b/diff)",
    );
    expect(body).toContain("_Commit: `cafef00` · Base: `deadbee`_");

    const sticky = await readSticky();
    expect(sticky?.commentId).toBe(900);
    expect(sticky?.runId).toBe("run-b");
  });

  it("POSTs exactly once when two calls race on the same unposted run", async () => {
    await seedRun("run-a");
    await seedResult("run-a", "t-1", "failed");

    await Promise.all([
      postPrComment("run-a", PROJECT_ID),
      postPrComment("run-a", PROJECT_ID),
    ]);

    // The loser must lose the mutex claim, retry after the winner persists,
    // observe its own runId already recorded, and skip the duplicate write.
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(writeCalls()).toHaveLength(1);
    // Both racers resolve the shared GitHub run context — including the
    // token mint — BEFORE either one claims, so both mint; only the claim
    // (not the mint) decides who POSTs.
    expect(mintInstallationToken).toHaveBeenCalledTimes(2);
    expect((await readSticky())?.commentId).toBe(900);
  });

  it("ignores another PR's same-branch run when picking the diff baseline", async () => {
    // A different PR in the same project reported the same head-branch name
    // (two fork PRs can both be `feat` while repo stays the target repo) and
    // already ran with t-1 failing.
    await seedRun("run-a", { createdAt: 1500, prNumber: 40 });
    await seedResult("run-a", "t-1", "failed");
    // This PR's first run also fails t-1. With no baseline of its own the
    // failure must render unsplit — not as "Still failing" against PR 40.
    await seedRun("run-b");
    await seedResult("run-b", "t-1", "failed");

    await postPrComment("run-b", PROJECT_ID);

    expect(writeCalls()).toHaveLength(1);
    const body = (JSON.parse(writeCalls()[0]!.body!) as { body: string }).body;
    expect(body).toContain(
      "**Failures (1)** — no baseline run to compare against",
    );
    expect(body).not.toContain("Still failing");
  });

  it("lets the newer run's summary land even when it loses the first-comment POST race", async () => {
    await seedRun("run-a", { createdAt: 2000 });
    await seedResult("run-a", "t-1", "failed");
    await seedRun("run-b", { createdAt: 2500, commitSha: "cafef00d" });
    await seedResult("run-b", "t-1", "failed");

    await Promise.all([
      postPrComment("run-a", PROJECT_ID),
      postPrComment("run-b", PROJECT_ID),
    ]);

    // Either run-b POSTs first (and run-a then observes the newer persisted
    // runId and skips), or run-a POSTs and run-b's mutex retry PATCHes the
    // fresh comment — in both interleavings the comment ends on run-b.
    const last = JSON.parse(writeCalls().at(-1)!.body!) as { body: string };
    expect(last.body).toContain("/runs/run-b");
    const sticky = await readSticky();
    expect(sticky?.commentId).toBe(900);
    expect(sticky?.runId).toBe("run-b");
    expect(sticky?.claimedAt).toBeNull();
  });

  it("serializes concurrent completions of different runs so the newest body lands last at GitHub", async () => {
    await seedRun("run-b", { createdAt: 2500 });
    await seedResult("run-b", "t-1", "failed");
    await seedRun("run-c", { createdAt: 3000, commitSha: "cafef00d" });
    await seedResult("run-c", "t-1", "failed");
    await seedSticky(900, "run-a");

    await Promise.all([
      postPrComment("run-b", PROJECT_ID),
      postPrComment("run-c", PROJECT_ID),
    ]);

    // Whichever completion claims first, the LAST write to reach GitHub must
    // carry run-c: either run-b writes and run-c follows serially, or run-c
    // wins outright and run-b skips against the newer persisted runId.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls.every((c) => c.method === "PATCH")).toBe(true);
    const last = JSON.parse(writeCalls().at(-1)!.body!) as { body: string };
    expect(last.body).toContain("/runs/run-c");
    const sticky = await readSticky();
    expect(sticky?.commentId).toBe(900);
    expect(sticky?.runId).toBe("run-c");
    expect(sticky?.claimedAt).toBeNull();
  });

  it("releases the claim on a POST failure so a later call can post", async () => {
    await seedRun("run-a");
    failNextPost = true;

    await postPrComment("run-a", PROJECT_ID);
    let sticky = await readSticky();
    expect(sticky?.commentId).toBeNull();
    expect(sticky?.claimedAt).toBeNull();

    failNextPost = false;
    await postPrComment("run-a", PROJECT_ID);
    sticky = await readSticky();
    expect(sticky?.commentId).toBe(900);
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("declines to overwrite a NEWER run's summary (stale watchdog finalize)", async () => {
    await seedRun("run-a", { createdAt: 1500 });
    await seedRun("run-z", { createdAt: 3000 });
    // run-z (ULID-newer) already rendered its summary.
    await seedSticky(900, "run-z");

    await postPrComment("run-a", PROJECT_ID);

    expect(fetchCalls).toHaveLength(0);
    // The shared context resolution mints BEFORE the sticky-row staleness
    // guard runs, so the token is still minted even though the guard then
    // makes this a no-op — no network POST/PATCH either way.
    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    expect((await readSticky())?.runId).toBe("run-z");
  });

  it("adopts an existing marker comment instead of duplicating when the initial POST's response was lost", async () => {
    await seedRun("run-a");
    await seedResult("run-a", "t-1", "failed");
    // A prior initial POST landed on GitHub, but its 2xx was lost before the
    // id could be persisted — the sticky row still has commentId null.
    listedComments = [
      { id: 555, body: "unrelated human comment" },
      { id: 777, body: `hi\n<!-- wrightful:pr-summary:${PROJECT_ID} -->` },
    ];

    await postPrComment("run-a", PROJECT_ID);

    expect(fetchCalls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(fetchCalls[1]!.path).toBe("/repos/acme/web/issues/comments/777");
    const sticky = await readSticky();
    expect(sticky?.commentId).toBe(777);
    expect(sticky?.runId).toBe("run-a");
  });

  it("reposts a fresh comment when the PATCH 404s (comment was deleted)", async () => {
    await seedRun("run-b");
    await seedSticky(900, "run-a");
    patchStatus = 404;
    nextCommentId = 901;

    await postPrComment("run-b", PROJECT_ID);

    expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    const sticky = await readSticky();
    expect(sticky?.commentId).toBe(901);
    expect(sticky?.runId).toBe("run-b");
  });

  it("no-ops without a prNumber", async () => {
    await seedRun("run-a", { prNumber: null });

    await postPrComment("run-a", PROJECT_ID);

    expect(fetchCalls).toHaveLength(0);
    expect(await readSticky()).toBeNull();
  });

  it("no-ops when called with a projectId that doesn't own the run", async () => {
    await seedRun("run-a");

    await postPrComment("run-a", "other-project");

    expect(fetchCalls).toHaveLength(0);
    expect(mintInstallationToken).not.toHaveBeenCalled();
    expect(await readSticky()).toBeNull();
  });
});
