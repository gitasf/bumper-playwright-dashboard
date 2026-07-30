// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  const harness = await buildHarness();
  return {
    ...harness,
    deleteSpy: vi.fn(async () => ({ deleted: 0, complete: true })),
  };
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

vi.mock("@/lib/artifacts/store", () => ({
  deleteProjectArtifactObjects: h.deleteSpy,
}));

vi.mock("void/log", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {} },
}));

const { resetTables } = await import("./harness");
const { teardownProject, teardownTeamRows } =
  await import("@/lib/project-teardown");
const {
  CLEANUP_FINALIZE_AFTER_SECONDS,
  EAGER_TEAM_CLEANUP_LIMIT,
  processProjectArtifactCleanup,
  projectArtifactCleanupJobValues,
  scheduleProjectArtifactCleanup,
  scheduleTeamArtifactCleanup,
  sweepProjectArtifactCleanup,
} = await import("@/lib/project-artifact-cleanup");
const {
  auditLog,
  memberships,
  projectArtifactCleanupJobs,
  projects,
  teamInvites,
  teams,
} = await import("../../../db/schema");
const { eq } = await import("void/_db");

const PROJECT_ONE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_TWO = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PROJECT_THREE = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

afterAll(async () => {
  await h.client.close();
});

interface WaitUntilRecorder {
  scheduled: Promise<unknown>[];
  ctx: { executionCtx: { waitUntil: (p: Promise<unknown>) => void } };
}

function makeCtx(): WaitUntilRecorder {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    ctx: {
      executionCtx: {
        waitUntil: (p: Promise<unknown>) => {
          scheduled.push(p);
        },
      },
    },
  };
}

async function projectIds(): Promise<string[]> {
  const rows = await h.db.select({ id: projects.id }).from(projects);
  return rows.map((r) => r.id).sort();
}

beforeEach(async () => {
  await resetTables(h.client, [
    teams,
    projects,
    memberships,
    teamInvites,
    auditLog,
    projectArtifactCleanupJobs,
  ]);
  // This suite specifically verifies production's parent-only team teardown.
  // The shared lightweight harness omits FKs by default, so restore the
  // relevant cascade constraints here instead of duplicating child deletes in
  // application code merely to satisfy the surrogate.
  await h.client.exec(
    'alter table "projects" add constraint "test_projects_team_fk" foreign key ("teamId") references "teams" ("id") on delete cascade',
  );
  await h.client.exec(
    'alter table "memberships" add constraint "test_memberships_team_fk" foreign key ("teamId") references "teams" ("id") on delete cascade',
  );
  await h.client.exec(
    'alter table "teamInvites" add constraint "test_team_invites_team_fk" foreign key ("teamId") references "teams" ("id") on delete cascade',
  );
  await h.client.exec(
    'alter table "auditLog" add constraint "test_audit_team_fk" foreign key ("teamId") references "teams" ("id") on delete cascade',
  );
  h.deleteSpy.mockReset();
  h.deleteSpy.mockResolvedValue({ deleted: 0, complete: true });
  await h.db.insert(teams).values([
    {
      id: "t1",
      slug: "one",
      name: "One",
      tier: "free",
      createdAt: 1_700_000_000,
    },
    {
      id: "t2",
      slug: "two",
      name: "Two",
      tier: "free",
      createdAt: 1_700_000_000,
    },
  ]);
  await h.db.insert(projects).values([
    {
      id: PROJECT_ONE,
      teamId: "t1",
      slug: "one",
      name: "One",
      createdAt: 1_700_000_000,
    },
    {
      id: PROJECT_TWO,
      teamId: "t2",
      slug: "two",
      name: "Two",
      createdAt: 1_700_000_000,
    },
    {
      id: PROJECT_THREE,
      teamId: "t1",
      slug: "three",
      name: "Three",
      createdAt: 1_700_000_000,
    },
  ]);
});

describe("teardownTeamRows", () => {
  it("enqueues the transaction's complete project snapshot before deleting the team", async () => {
    await h.db.insert(memberships).values({
      id: "member-t1",
      userId: "user-t1",
      teamId: "t1",
      role: "owner",
      createdAt: 1_700_000_000,
    });
    await h.db.insert(teamInvites).values({
      id: "invite-t1",
      teamId: "t1",
      tokenHash: "invite-hash",
      role: "member",
      createdBy: "user-t1",
      createdAt: 1_700_000_000,
      expiresAt: 9_999_999_999,
    });

    const deletedIds = await teardownTeamRows("t1", () => 1_700_000_100);

    expect(deletedIds.sort()).toEqual([PROJECT_ONE, PROJECT_THREE].sort());
    expect(await projectIds()).toEqual([PROJECT_TWO]);
    const remainingTeams = await h.db.select({ id: teams.id }).from(teams);
    expect(remainingTeams).toEqual([{ id: "t2" }]);
    await expect(h.db.select().from(memberships)).resolves.toEqual([]);
    await expect(h.db.select().from(teamInvites)).resolves.toEqual([]);
    const jobs = await h.db
      .select({
        projectId: projectArtifactCleanupJobs.projectId,
        teamId: projectArtifactCleanupJobs.teamId,
        attempts: projectArtifactCleanupJobs.attempts,
      })
      .from(projectArtifactCleanupJobs);
    expect(jobs.sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual(
      [
        { projectId: PROJECT_ONE, teamId: "t1", attempts: 0 },
        { projectId: PROJECT_THREE, teamId: "t1", attempts: 0 },
      ],
    );
  });
});

describe("teardownProject", () => {
  it("deletes ONLY the target project row and leaves siblings intact", async () => {
    const { ctx } = makeCtx();
    await teardownProject(ctx as never, "t1", PROJECT_ONE);

    expect(await projectIds()).toEqual([PROJECT_THREE, PROJECT_TWO].sort());
  });

  it("schedules the R2 sweep for exactly the destroyed (teamId, projectId)", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_ONE);

    await expect(rec.scheduled[0]).resolves.toBeUndefined();
    expect(h.deleteSpy).toHaveBeenCalledTimes(1);
    expect(h.deleteSpy).toHaveBeenCalledWith("t1", PROJECT_ONE, 100);
    expect(rec.scheduled).toHaveLength(1);
  });

  it("schedules the sweep only AFTER the row delete has committed", async () => {
    let rowsPresentAtSweep: string[] | undefined;
    h.deleteSpy.mockImplementationOnce(async () => {
      rowsPresentAtSweep = await projectIds();
      return { deleted: 0, complete: true };
    });
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_ONE);
    await rec.scheduled[0];

    expect(rowsPresentAtSweep).toEqual([PROJECT_THREE, PROJECT_TWO].sort());
  });

  it("does not delete or schedule cleanup for an unknown projectId", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", "nope");

    expect(await projectIds()).toEqual(
      [PROJECT_ONE, PROJECT_TWO, PROJECT_THREE].sort(),
    );
    expect(h.deleteSpy).not.toHaveBeenCalled();
  });

  it("does not delete a project owned by a different team", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_TWO);

    expect(await projectIds()).toEqual(
      [PROJECT_ONE, PROJECT_TWO, PROJECT_THREE].sort(),
    );
    expect(h.deleteSpy).not.toHaveBeenCalled();
  });

  it("commits the deletion audit only with a successful project delete", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_ONE, {
      actorUserId: "u-owner",
      input: {
        teamId: "t1",
        action: "project.delete",
        targetType: "project",
        targetId: "one",
        metadata: { projectId: PROJECT_ONE, projectName: "One" },
      },
    });

    const rows = await h.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId: "t1",
      projectId: null,
      actorUserId: "u-owner",
      action: "project.delete",
      targetId: "one",
    });
  });

  it("commits a durable cleanup job in the same transaction as deletion", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_ONE);
    await rec.scheduled[0];

    const jobs = await h.db.select().from(projectArtifactCleanupJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      teamId: "t1",
      projectId: PROJECT_ONE,
      attempts: 1,
      lastError: null,
    });
  });
});

describe("scheduleProjectArtifactCleanup", () => {
  async function seedDueJob(
    projectId: string,
    createdAt: number = Math.floor(Date.now() / 1000) - 2_000,
  ): Promise<void> {
    await h.db
      .insert(projectArtifactCleanupJobs)
      .values(projectArtifactCleanupJobValues("t1", projectId, createdAt));
  }

  it("persists a transient R2 failure and completes on a later retry", async () => {
    await seedDueJob(PROJECT_ONE);
    h.deleteSpy.mockRejectedValueOnce(new Error("R2 down"));
    const rec = makeCtx();

    expect(() =>
      scheduleProjectArtifactCleanup(rec.ctx as never, PROJECT_ONE),
    ).not.toThrow();
    expect(rec.scheduled).toHaveLength(1);
    await expect(rec.scheduled[0]).resolves.toBeUndefined();

    const [failed] = await h.db.select().from(projectArtifactCleanupJobs);
    expect(failed).toMatchObject({
      projectId: PROJECT_ONE,
      attempts: 1,
      lastError: "R2 down",
    });

    h.deleteSpy.mockResolvedValueOnce({ deleted: 7, complete: true });
    await expect(
      processProjectArtifactCleanup(
        PROJECT_ONE,
        Math.max(
          failed!.nextAttemptAt,
          // Past the presigned-PUT hold, so this pass is allowed to finalize
          // rather than parking the job for the final verification sweep.
          failed!.createdAt + CLEANUP_FINALIZE_AFTER_SECONDS,
        ),
      ),
    ).resolves.toEqual({ kind: "complete", deleted: 7 });
    await expect(
      h.db.select().from(projectArtifactCleanupJobs),
    ).resolves.toEqual([]);
  });

  it("leaves the project rows untouched (it is byte-cleanup only)", async () => {
    const deletedProject = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    await seedDueJob(deletedProject);
    const rec = makeCtx();
    scheduleProjectArtifactCleanup(rec.ctx as never, deletedProject);
    await rec.scheduled[0];
    expect(await projectIds()).toEqual(
      [PROJECT_ONE, PROJECT_TWO, PROJECT_THREE].sort(),
    );
  });

  it("keeps a page-budget-limited job discoverable for continuation", async () => {
    await seedDueJob(PROJECT_ONE);
    h.deleteSpy.mockResolvedValueOnce({
      deleted: 100_000,
      complete: false,
    });

    await expect(processProjectArtifactCleanup(PROJECT_ONE)).resolves.toEqual({
      kind: "incomplete",
      deleted: 100_000,
    });
    const [pending] = await h.db.select().from(projectArtifactCleanupJobs);
    expect(pending).toMatchObject({
      projectId: PROJECT_ONE,
      attempts: 1,
      lastError: null,
    });

    h.deleteSpy.mockResolvedValueOnce({ deleted: 1_000, complete: true });
    await expect(
      processProjectArtifactCleanup(
        PROJECT_ONE,
        Math.max(
          pending!.nextAttemptAt,
          pending!.createdAt + CLEANUP_FINALIZE_AFTER_SECONDS,
        ),
      ),
    ).resolves.toEqual({ kind: "complete", deleted: 1_000 });
  });

  it("does not let an expired claimant overwrite its successor's lease", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedDueJob(PROJECT_ONE, now - 2_000);
    const firstPass = Promise.withResolvers<{
      deleted: number;
      complete: boolean;
    }>();
    const secondPass = Promise.withResolvers<{
      deleted: number;
      complete: boolean;
    }>();
    h.deleteSpy
      .mockImplementationOnce(() => firstPass.promise)
      .mockImplementationOnce(() => secondPass.promise);

    const first = processProjectArtifactCleanup(PROJECT_ONE, now);
    await vi.waitFor(() => expect(h.deleteSpy).toHaveBeenCalledTimes(1));

    const successorClaimedAt = now + 10 * 60;
    const second = processProjectArtifactCleanup(
      PROJECT_ONE,
      successorClaimedAt,
    );
    await vi.waitFor(() => expect(h.deleteSpy).toHaveBeenCalledTimes(2));

    firstPass.resolve({ deleted: 100, complete: false });
    await expect(first).resolves.toEqual({
      kind: "superseded",
      deleted: 100,
    });

    const [leased] = await h.db.select().from(projectArtifactCleanupJobs);
    expect(leased).toMatchObject({
      attempts: 2,
      nextAttemptAt: successorClaimedAt + 10 * 60,
    });

    secondPass.resolve({ deleted: 1, complete: false });
    await expect(second).resolves.toEqual({ kind: "incomplete", deleted: 1 });
    const [pending] = await h.db.select().from(projectArtifactCleanupJobs);
    expect(pending).toMatchObject({
      attempts: 2,
      nextAttemptAt: successorClaimedAt + 60,
    });
  });

  it("schedules a failed retry from completion time, not stale claim time", async () => {
    const claimAt = Math.floor(Date.now() / 1000) - 1_000;
    await seedDueJob(PROJECT_ONE, claimAt - 2_000);
    h.deleteSpy.mockRejectedValueOnce(new Error("slow failure"));
    const finishedAt = claimAt + 700;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(finishedAt * 1_000);

    try {
      await expect(
        processProjectArtifactCleanup(PROJECT_ONE, claimAt),
      ).resolves.toEqual({ kind: "failed", message: "slow failure" });
    } finally {
      dateSpy.mockRestore();
    }

    const [pending] = await h.db.select().from(projectArtifactCleanupJobs);
    expect(pending).toMatchObject({
      attempts: 1,
      // The point of the assertion is the BASE, not the offset: the retry is
      // measured from when the attempt finished, not from the stale `claimAt`
      // this pass was handed. 360s is the first-attempt backoff, deliberately
      // longer than the five-minute cron interval.
      nextAttemptAt: finishedAt + 360,
      updatedAt: finishedAt,
    });
  });
});

describe("sweepProjectArtifactCleanup — batch fairness", () => {
  it("serves the longest-overdue jobs, so a retry cohort cannot hold the batch", async () => {
    // SWEEP_JOB_LIMIT is 4. Seed five jobs: four OLD ones that already ran and
    // are only just due again, plus one NEWER job that has been due far longer.
    // Ordering by createdAt would hand every slot to the old cohort on every
    // tick and starve the newer deletion indefinitely; ordering by how overdue
    // each job is lets the waiting one through.
    const now = Math.floor(Date.now() / 1000);
    const retried = ["r1", "r2", "r3", "r4"];
    await h.db.insert(projectArtifactCleanupJobs).values([
      ...retried.map((projectId) => ({
        ...projectArtifactCleanupJobValues("t1", projectId, now - 10_000),
        attempts: 3,
        // Backed off repeatedly and became due one second ago.
        nextAttemptAt: now - 1,
      })),
      // Created later, but never worked, so it has been due for an hour.
      projectArtifactCleanupJobValues("t1", "starved", now - 3_600),
    ]);
    h.deleteSpy.mockResolvedValue({ deleted: 0, complete: true });

    const result = await sweepProjectArtifactCleanup(now);

    // Four of the five jobs are worked, and a worked-to-completion job deletes
    // its own row — so whatever is left over is precisely the job that missed
    // the batch.
    expect(result.claimed).toBe(4);
    const leftover = await h.db
      .select({ projectId: projectArtifactCleanupJobs.projectId })
      .from(projectArtifactCleanupJobs);
    expect(leftover).toHaveLength(1);
    // The one that waited its turn is a member of the retry cohort, NOT the
    // longer-overdue `starved` job. Under the old createdAt ordering the four
    // older rows took every slot and `starved` was the leftover on every tick.
    expect(retried).toContain(leftover[0]!.projectId);
  });
});

describe("scheduleTeamArtifactCleanup", () => {
  it("dispatches one bounded eager pass and leaves the rest immediately due", async () => {
    const now = Math.floor(Date.now() / 1000);
    await h.db
      .insert(projectArtifactCleanupJobs)
      .values([
        projectArtifactCleanupJobValues("gone", PROJECT_ONE, now),
        projectArtifactCleanupJobValues("gone", PROJECT_TWO, now),
        projectArtifactCleanupJobValues("gone", PROJECT_THREE, now),
      ]);
    const rec = makeCtx();

    scheduleTeamArtifactCleanup(rec.ctx as never, [
      PROJECT_ONE,
      PROJECT_TWO,
      PROJECT_THREE,
    ]);

    expect(rec.scheduled).toHaveLength(EAGER_TEAM_CLEANUP_LIMIT);
    await Promise.all(rec.scheduled);
    const untouched = await h.db
      .select({
        projectId: projectArtifactCleanupJobs.projectId,
        attempts: projectArtifactCleanupJobs.attempts,
        nextAttemptAt: projectArtifactCleanupJobs.nextAttemptAt,
      })
      .from(projectArtifactCleanupJobs)
      .where(eq(projectArtifactCleanupJobs.attempts, 0));
    expect(untouched).toHaveLength(2);
    expect(untouched.every((job) => job.nextAttemptAt <= now)).toBe(true);
  });
});
