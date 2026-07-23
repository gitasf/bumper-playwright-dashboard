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
 * Claim-before-POST concurrency coverage for the check-run surface, driven
 * through the production entry point `postGithubRunSurfaces` (M7): two
 * concurrent completions of the same run (`completeRun` racing
 * `finalizeStaleRun`, or a sharded run's last two shards landing together)
 * must never both POST a check run for the same commit. The runs seeded here
 * carry no `prNumber`, so the sibling PR-comment surface no-ops without
 * touching the DB or network. Runs against a real Postgres (in-process
 * pglite), following the `sharded-complete.test.ts` pattern, so the atomic
 * claim `UPDATE ... WHERE` actually executes rather than just typechecking.
 *
 * Deliberately a plain `*.test.ts` (Node lane), NOT `*.workers.test.ts`: per
 * `vitest.workers.config.ts`, pglite/disk-bound DB-integration tests stay on
 * the Node lane and are excluded from the miniflare/workerd pool. The pure
 * (`buildCheckRunOutput`, `statusToConclusion`, …) tests stay in
 * `github-checks.workers.test.ts`.
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

// `void/db` → the pglite instance, with the REAL Drizzle operators from the
// non-intercepted `void/_db` entry (same pattern as sharded-complete.test.ts).
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

vi.mock("void/env", () => ({
  env: { WRIGHTFUL_PUBLIC_URL: "https://dash.example" },
}));

// Force the GitHub App "on" without needing real credentials — mirrors the
// approved test approach (mock the flag, not the env vars it reads).
vi.mock("@/lib/config", () => ({
  githubAppEnabled: () => true,
}));

const mintInstallationToken = vi.fn(async (_installationId: number) =>
  Promise.resolve("token-123"),
);

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];
let fetchDelayMs = 15;
let nextCheckRunId = 555;
let failNextPost = false;

// Stub the network-touching bits — `mintInstallationToken` from the env-reading
// `@/lib/github-app` layer and `githubFetch` from the env-free
// `@/lib/github-http` core — but keep the real `parseRepoOwner` (pure) via
// `importActual`. A small delay on the fetch is
// what opens the window for the LOSING concurrent call's claim-reread to
// observe the winner's still-in-flight (not-yet-persisted) claim, exercising
// the "lost the race, real id hasn't landed yet, skip" branch instead of the
// "winner already finished, PATCH their id" branch.
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
      fetchCalls.push({ method, path });
      await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
      if (method === "POST" && failNextPost) {
        return new Response("boom", {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
      return new Response(JSON.stringify({ id: nextCheckRunId }), {
        status: method === "POST" ? 201 : 200,
      });
    },
  };
});

const { postGithubRunSurfaces } = await import("@/lib/github-run-surfaces");
const { runs, teams, projects, githubInstallations } = await import("@schema");
const { eq } = await import("void/_db");
const { getTableConfig } = await import("void/schema-pg");
const { resetTables } = await import("./pg-integration/harness");

const TEAM_ID = "team-1";
const PROJECT_ID = "proj-1";

async function seedTeamAndProject() {
  await h.db.insert(teams).values({
    id: TEAM_ID,
    slug: "acme",
    name: "Acme",
    createdAt: 1000,
    // The harness DDL (createTableSql) carries no column DEFAULTs; set the
    // NOT NULL `tier` explicitly (same note as github-pr-comment-claim.test.ts).
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

async function seedRun(id: string, githubCheckRunId: number | null = null) {
  await h.db.insert(runs).values({
    id,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    idempotencyKey: id,
    totalTests: 3,
    passed: 3,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 100,
    status: "passed",
    repo: "acme/web",
    commitSha: "deadbeef",
    createdAt: 1000,
    lastActivityAt: 1000,
    completedAt: 1000,
    origin: "ci",
    githubCheckRunId,
  });
}

async function readCheckRunId(id: string): Promise<number | null> {
  const rows = await h.db
    .select({ githubCheckRunId: runs.githubCheckRunId })
    .from(runs)
    .where(eq(runs.id, id));
  return rows[0]?.githubCheckRunId ?? null;
}

async function readClaimedAt(id: string): Promise<number | null> {
  const rows = await h.db
    .select({ githubCheckClaimedAt: runs.githubCheckClaimedAt })
    .from(runs)
    .where(eq(runs.id, id));
  return rows[0]?.githubCheckClaimedAt ?? null;
}

beforeAll(async () => {
  await resetTables(h.client, [teams, projects, githubInstallations, runs]);
});

afterAll(async () => {
  await h.client.close();
});

beforeEach(async () => {
  for (const t of [runs, githubInstallations, projects, teams]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`delete from "${name}";`);
  }
  await seedTeamAndProject();
  fetchCalls = [];
  fetchDelayMs = 15;
  nextCheckRunId = 555;
  failNextPost = false;
  mintInstallationToken.mockClear();
});

describe("postGithubRunSurfaces — check-run claim-before-POST concurrency", () => {
  it("posts exactly once when two calls race on the same unposted run", async () => {
    await seedRun("run-race-1");

    await Promise.all([
      postGithubRunSurfaces("run-race-1", PROJECT_ID),
      postGithubRunSurfaces("run-race-1", PROJECT_ID),
    ]);

    // Exactly one network round-trip total: the winner's single POST. The
    // loser must have lost the claim, rereaded, seen the winner's real id
    // still not landed, and skipped — NOT issued its own POST.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.method).toBe("POST");
    // Both racers resolve the shared GitHub run context — including the
    // token mint — BEFORE either one claims (see `github-run-surfaces.ts`),
    // so both mint; only the claim (not the mint) decides who POSTs.
    expect(mintInstallationToken).toHaveBeenCalledTimes(2);
    expect(await readCheckRunId("run-race-1")).toBe(nextCheckRunId);
  });

  it("releases the claim on a POST failure so a later call can post", async () => {
    await seedRun("run-fail-1");
    failNextPost = true;

    await postGithubRunSurfaces("run-fail-1", PROJECT_ID);
    // Never throws (best-effort), and the failed claim is released back to
    // null rather than left dangling for the full TTL.
    expect(await readCheckRunId("run-fail-1")).toBeNull();
    expect(await readClaimedAt("run-fail-1")).toBeNull();

    failNextPost = false;
    await postGithubRunSurfaces("run-fail-1", PROJECT_ID);

    const posts = fetchCalls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(await readCheckRunId("run-fail-1")).toBe(nextCheckRunId);
    expect(await readClaimedAt("run-fail-1")).toBeNull();
  });

  it("reclaims an EXPIRED claim and posts", async () => {
    await seedRun("run-expired-1");
    // A claim taken 200s ago — well past the 120s TTL — left behind by a
    // poster that crashed/timed out before persisting a real id.
    const staleClaimedAt = Math.floor(Date.now() / 1000) - 200;
    await h.db
      .update(runs)
      .set({ githubCheckClaimedAt: staleClaimedAt })
      .where(eq(runs.id, "run-expired-1"));

    await postGithubRunSurfaces("run-expired-1", PROJECT_ID);

    const posts = fetchCalls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(await readCheckRunId("run-expired-1")).toBe(nextCheckRunId);
    expect(await readClaimedAt("run-expired-1")).toBeNull();
  });

  it("skips (no POST/PATCH) on a FRESH, still-live claim", async () => {
    await seedRun("run-fresh-1");
    // A claim taken only 10s ago — well within the 120s TTL, so it's still
    // "someone else is posting right now", not reclaimable.
    const freshClaimedAt = Math.floor(Date.now() / 1000) - 10;
    await h.db
      .update(runs)
      .set({ githubCheckClaimedAt: freshClaimedAt })
      .where(eq(runs.id, "run-fresh-1"));

    await postGithubRunSurfaces("run-fresh-1", PROJECT_ID);

    expect(fetchCalls).toHaveLength(0);
    // The shared context resolution mints BEFORE the claim check runs, so the
    // token is still minted even though the live claim then makes this a
    // no-op — no network POST/PATCH either way.
    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    // Untouched — still the live claim, not clobbered or cleared, and no real
    // id has landed.
    expect(await readClaimedAt("run-fresh-1")).toBe(freshClaimedAt);
    expect(await readCheckRunId("run-fresh-1")).toBeNull();
  });

  it("no-ops (no read match, no claim, no POST) when called with a projectId that doesn't own the run", async () => {
    await seedRun("run-wrong-project-1");

    // Every `runs` predicate on this path ANDs `projectId` — a
    // caller passing a DIFFERENT project's id must find nothing, exactly like
    // `runByIdWhere` elsewhere in the codebase, instead of falling through to
    // a cross-tenant claim/POST against another team's run.
    await postGithubRunSurfaces("run-wrong-project-1", "other-project");

    expect(fetchCalls).toHaveLength(0);
    expect(mintInstallationToken).not.toHaveBeenCalled();
    expect(await readCheckRunId("run-wrong-project-1")).toBeNull();
    expect(await readClaimedAt("run-wrong-project-1")).toBeNull();
  });
});
