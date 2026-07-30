// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});
// A fresh insert runs the artifact-byte quota gate, which reads the tier caps
// off `void/env` — and the node lane aliases that to an EMPTY stub, so without
// this the write transaction throws before it ever reaches the parent lock.
// Generous caps keep the gate open; the lock ordering is what's under test.
vi.mock("void/env", () => ({
  env: {
    WRIGHTFUL_FREE_MONTHLY_RUNS: 1_000_000,
    WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS: 1_000_000,
    WRIGHTFUL_FREE_ARTIFACT_BYTES: 1_000_000_000,
    WRIGHTFUL_QUOTA_SOFT_WARN_PCT: 80,
  },
}));
vi.mock("void/storage", () => ({
  storage: {
    put: () => Promise.resolve(),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    delete: () => Promise.resolve(),
  },
}));

const { resetTables } = await import("./harness");
const { registerArtifacts } = await import("@/lib/artifacts/store");
const { makeTenantScope } = await import("@/lib/scope");
const { artifacts, projects, runs, teams, testResults, usageCounters } =
  await import("../../../db/schema");

afterAll(async () => {
  await h.client.close();
});

const postgresUrl = process.env.PG_TEST_URL;

describe.skipIf(!postgresUrl)(
  "direct artifact capability vs teardown (real Postgres)",
  () => {
    it("holds the project key-share lock until the presigned PUT is minted", async () => {
      await resetTables(h.client, [
        teams,
        projects,
        runs,
        testResults,
        artifacts,
      ]);
      await h.db.insert(teams).values({
        id: "artifact-team",
        slug: "artifact",
        name: "Artifact",
        tier: "free",
        createdAt: 1,
      });
      await h.db.insert(projects).values({
        id: "artifact-project",
        teamId: "artifact-team",
        slug: "artifact",
        name: "Artifact",
        createdAt: 1,
      });
      await h.db.insert(runs).values({
        id: "artifact-run",
        teamId: "artifact-team",
        projectId: "artifact-project",
        totalTests: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 1,
        status: "running",
        origin: "ci",
        createdAt: 1,
        lastActivityAt: 1,
      });
      await h.db.insert(testResults).values({
        id: "artifact-result",
        projectId: "artifact-project",
        runId: "artifact-run",
        testId: "test",
        title: "test",
        file: "test.ts",
        status: "passed",
        durationMs: 1,
        retryCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await h.db.insert(artifacts).values({
        id: "artifact-existing",
        projectId: "artifact-project",
        testResultId: "artifact-result",
        type: "screenshot",
        name: "shot.png",
        contentType: "image/png",
        sizeBytes: 100,
        r2Key: "t/artifact-team/p/artifact-project/shot.png",
        attempt: 0,
        createdAt: 1,
      });

      const signer = Promise.withResolvers<string>();
      const signStarted = Promise.withResolvers<void>();
      const registration = registerArtifacts(
        makeTenantScope({
          teamId: "artifact-team",
          projectId: "artifact-project",
          teamSlug: "artifact",
          projectSlug: "artifact",
        }),
        {
          runId: "artifact-run",
          artifacts: [
            {
              testResultId: "artifact-result",
              type: "screenshot",
              name: "shot.png",
              contentType: "image/png",
              sizeBytes: 100,
              attempt: 0,
            },
          ],
        },
        1_000,
        1,
        () => {
          signStarted.resolve();
          return signer.promise;
        },
      );
      await signStarted.promise;

      const { Client } = await import("pg");
      const teardown = new Client({ connectionString: postgresUrl });
      await teardown.connect();
      try {
        await teardown.query("begin");
        const blocked = await teardown
          .query(
            'select "id" from "projects" where "id" = $1 for update nowait',
            ["artifact-project"],
          )
          .then(
            () => null,
            (error: unknown) => error as { code?: string },
          );
        expect(blocked?.code).toBe("55P03");
      } finally {
        await teardown.query("rollback").catch(() => undefined);
        await teardown.end();
      }

      signer.resolve("https://r2.example/presigned-put");
      await expect(registration).resolves.toEqual({
        kind: "ok",
        uploads: [
          {
            artifactId: "artifact-existing",
            r2Key: "t/artifact-team/p/artifact-project/shot.png",
            uploadUrl: "https://r2.example/presigned-put",
          },
        ],
      });
    });

    // The write transaction takes its parent lock BEFORE inserting `artifacts`.
    // Without it the insert's FK key-share-locks the project row, and the
    // `usageCounters` upsert then waits on the TEAM row behind teardown's
    // `for update` — while teardown's cascade waits on the project row this
    // transaction is holding. That is a 40P01. Parking at the parent instead
    // means the writer holds no child row at all, which is what this asserts.
    it("parks at the parent without holding the project row when writing rows", async () => {
      await resetTables(h.client, [
        teams,
        projects,
        runs,
        testResults,
        artifacts,
        usageCounters,
      ]);
      // `resetTables` deliberately omits FKs and indexes, but the IMPLICIT
      // key-share locks those FKs take are the entire mechanism under test —
      // without them the pre-fix ordering would pass this too. Recreate just
      // the two that form the cycle, plus the arbiter index the usage upsert's
      // ON CONFLICT needs.
      await h.client.exec(
        `alter table "artifacts" add constraint "artifacts_projectId_fk"
           foreign key ("projectId") references "projects"("id") on delete cascade;`,
      );
      await h.client.exec(
        `alter table "usageCounters" add constraint "usageCounters_teamId_fk"
           foreign key ("teamId") references "teams"("id") on delete cascade;`,
      );
      await h.client.exec(
        `create unique index "usageCounters_team_period_idx"
           on "usageCounters" ("teamId", "periodStart");`,
      );
      await h.db.insert(teams).values({
        id: "write-team",
        slug: "write",
        name: "Write",
        tier: "free",
        createdAt: 1,
      });
      await h.db.insert(projects).values({
        id: "write-project",
        teamId: "write-team",
        slug: "write",
        name: "Write",
        createdAt: 1,
      });
      await h.db.insert(runs).values({
        id: "write-run",
        teamId: "write-team",
        projectId: "write-project",
        totalTests: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 1,
        status: "running",
        origin: "ci",
        createdAt: 1,
        lastActivityAt: 1,
      });
      await h.db.insert(testResults).values({
        id: "write-result",
        projectId: "write-project",
        runId: "write-run",
        testId: "test",
        title: "test",
        file: "test.ts",
        status: "passed",
        durationMs: 1,
        retryCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });

      const { Client } = await import("pg");
      const blocker = new Client({ connectionString: postgresUrl });
      const observer = new Client({ connectionString: postgresUrl });
      await blocker.connect();
      await observer.connect();
      let pending: Promise<unknown> | undefined;

      try {
        await blocker.query("begin");
        await blocker.query(
          'select "id" from "teams" where "id" = $1 for update',
          ["write-team"],
        );

        // No signer: this is the worker-proxied path, so the ONLY lock in play
        // is the write transaction's own — `finalizeUploads` short-circuits.
        pending = registerArtifacts(
          makeTenantScope({
            teamId: "write-team",
            projectId: "write-project",
            teamSlug: "write",
            projectSlug: "write",
          }),
          {
            runId: "write-run",
            artifacts: [
              {
                testResultId: "write-result",
                type: "screenshot",
                name: "fresh.png",
                contentType: "image/png",
                sizeBytes: 100,
                attempt: 0,
              },
            ],
          },
          1_000,
          1,
        );

        await vi.waitFor(
          async () => {
            const waiting = await observer.query<{ count: string }>(
              `select count(*)::text as count
                 from pg_stat_activity
                where pid <> pg_backend_pid()
                  and wait_event_type = 'Lock'
                  and query ilike '%from "teams"%for key share%'`,
            );
            expect(Number(waiting.rows[0]?.count ?? 0)).toBeGreaterThan(0);
          },
          { timeout: 5_000, interval: 25 },
        );

        // Blocked at the parent, so no `artifacts` row was inserted and the
        // project row is free. Under the pre-fix ordering this raises 55P03.
        await expect(
          blocker.query(
            'select "id" from "projects" where "id" = $1 for update nowait',
            ["write-project"],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        await blocker.end();
        await observer.end();
      }

      await expect(pending).resolves.toMatchObject({ kind: "ok" });
    });
  },
);
