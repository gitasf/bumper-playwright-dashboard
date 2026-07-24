// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  const harness = await buildHarness();
  return { ...harness, deleteSpy: vi.fn(async () => {}) };
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
const { teardownProject, scheduleProjectArtifactCleanup } =
  await import("@/lib/project-teardown");
const { projects } = await import("../../../db/schema");

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
  await resetTables(h.client, [projects]);
  h.deleteSpy.mockClear();
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

describe("teardownProject", () => {
  it("deletes ONLY the target project row and leaves siblings intact", async () => {
    const { ctx } = makeCtx();
    await teardownProject(ctx as never, "t1", PROJECT_ONE);

    expect(await projectIds()).toEqual([PROJECT_THREE, PROJECT_TWO].sort());
  });

  it("schedules the R2 sweep for exactly the destroyed (teamId, projectId)", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_ONE);

    expect(h.deleteSpy).toHaveBeenCalledTimes(1);
    expect(h.deleteSpy).toHaveBeenCalledWith("t1", PROJECT_ONE);
    expect(rec.scheduled).toHaveLength(1);
    await expect(rec.scheduled[0]).resolves.toBeUndefined();
  });

  it("schedules the sweep only AFTER the row delete has committed", async () => {
    let rowsPresentAtSweep: string[] | undefined;
    h.deleteSpy.mockImplementationOnce(async () => {
      rowsPresentAtSweep = await projectIds();
    });
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_ONE);
    await rec.scheduled[0];

    expect(rowsPresentAtSweep).toEqual([PROJECT_THREE, PROJECT_TWO].sort());
  });

  it("does not delete anything for an unknown projectId (no-op delete), still schedules its sweep", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", "nope");

    expect(await projectIds()).toEqual(
      [PROJECT_ONE, PROJECT_TWO, PROJECT_THREE].sort(),
    );
    expect(h.deleteSpy).toHaveBeenCalledWith("t1", "nope");
  });

  it("does not delete a project owned by a different team", async () => {
    const rec = makeCtx();
    await teardownProject(rec.ctx as never, "t1", PROJECT_TWO);

    expect(await projectIds()).toEqual(
      [PROJECT_ONE, PROJECT_TWO, PROJECT_THREE].sort(),
    );
  });
});

describe("scheduleProjectArtifactCleanup", () => {
  it("swallows a failing sweep — a failed R2 delete never rethrows", async () => {
    h.deleteSpy.mockRejectedValueOnce(new Error("R2 down"));
    const rec = makeCtx();

    expect(() =>
      scheduleProjectArtifactCleanup(rec.ctx as never, "t1", PROJECT_ONE),
    ).not.toThrow();
    expect(rec.scheduled).toHaveLength(1);
    await expect(rec.scheduled[0]).resolves.toBeUndefined();
  });

  it("leaves the project rows untouched (it is byte-cleanup only)", async () => {
    const rec = makeCtx();
    scheduleProjectArtifactCleanup(rec.ctx as never, "t1", PROJECT_ONE);
    await rec.scheduled[0];
    expect(await projectIds()).toEqual(
      [PROJECT_ONE, PROJECT_TWO, PROJECT_THREE].sort(),
    );
  });
});
