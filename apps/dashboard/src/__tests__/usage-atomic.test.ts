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

const h = await vi.hoisted(async () => {
  const schema = await import("../../db/schema");
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
vi.mock("void/env", () => ({ env: {} }));

const {
  reconcileUsageCounterRowStatement,
  usageGuardedBumpStatement,
  usageBumpStatement,
  reconcileUsage,
  monthStartSeconds,
} = await import("@/lib/usage");
const { teams, projects, runs, artifacts, usageCounters } =
  await import("../../db/schema");
const { getTableConfig } = await import("void/schema-pg");
const { eq } = await import("void/_db");

function pgType(columnType: string): string {
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Integer")) return "integer";
  if (columnType.includes("Jsonb")) return "jsonb";
  return "text";
}
function createTableSql(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const parts = [`"${c.name}"`, pgType(c.columnType)];
    if (c.primary) parts.push("primary key");
    if (c.notNull && !c.primary) parts.push("not null");
    return parts.join(" ");
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const NOW = Math.floor(Date.UTC(2026, 6, 17, 12, 0, 0) / 1000);
const PERIOD = monthStartSeconds(NOW);

const EXEC = h.db as unknown as Parameters<typeof usageBumpStatement>[4];

async function readCounter(teamId: string) {
  const rows = await h.db
    .select({
      runsCount: usageCounters.runsCount,
      artifactBytes: usageCounters.artifactBytes,
      artifactCount: usageCounters.artifactCount,
    })
    .from(usageCounters)
    .where(eq(usageCounters.teamId, teamId));
  return rows[0];
}

beforeAll(async () => {
  for (const t of [teams, projects, runs, artifacts, usageCounters]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`drop table if exists "${name}" cascade;`);
    await h.client.exec(createTableSql(t));
  }
  await h.client.exec(
    `create unique index "usageCounters_team_period_idx" on "usageCounters" ("teamId","periodStart");`,
  );
});

afterAll(async () => {
  await h.client.close();
});

beforeEach(async () => {
  for (const t of [teams, projects, runs, artifacts, usageCounters]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`delete from "${name}";`);
  }
});

describe("usageGuardedBumpStatement", () => {
  it("applies an increment that stays within the limit and returns the row", async () => {
    const applied = await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { artifactBytes: 40 },
      { dimension: "artifactBytes", limit: 100 },
      NOW,
      EXEC,
    );
    expect(applied).toHaveLength(1);
    expect((await readCounter("team-1"))?.artifactBytes).toBe(40);
  });

  it("REJECTS (empty returning, no write) an increment that would exceed the limit on an existing row", async () => {
    await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { artifactBytes: 90 },
      { dimension: "artifactBytes", limit: 100 },
      NOW,
      EXEC,
    );
    const rejected = await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { artifactBytes: 20 },
      { dimension: "artifactBytes", limit: 100 },
      NOW,
      EXEC,
    );
    expect(rejected).toHaveLength(0);
    expect((await readCounter("team-1"))?.artifactBytes).toBe(90);
  });

  it.each([
    ["artifactBytes", { artifactBytes: 101 }],
    ["runs", { runs: 4 }],
  ] as const)(
    "rejects a first-write %s delta above its limit without creating a row",
    async (dimension, delta) => {
      const rejected = await usageGuardedBumpStatement(
        "team-1",
        PERIOD,
        delta,
        { dimension, limit: dimension === "runs" ? 3 : 100 },
        NOW,
        EXEC,
      );
      expect(rejected).toHaveLength(0);
      expect(await readCounter("team-1")).toBeUndefined();
    },
  );

  it("is exactly-at-limit inclusive (boundary allowed)", async () => {
    await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { artifactBytes: 60 },
      { dimension: "artifactBytes", limit: 100 },
      NOW,
      EXEC,
    );
    const applied = await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { artifactBytes: 40 },
      { dimension: "artifactBytes", limit: 100 },
      NOW,
      EXEC,
    );
    expect(applied).toHaveLength(1);
    expect((await readCounter("team-1"))?.artifactBytes).toBe(100);
  });

  it("bumps unconditionally when the limit is non-finite (billing off ⇒ unlimited)", async () => {
    const applied = await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { artifactBytes: 10 ** 12 },
      { dimension: "artifactBytes", limit: Number.POSITIVE_INFINITY },
      NOW,
      EXEC,
    );
    expect(applied).toHaveLength(1);
    expect((await readCounter("team-1"))?.artifactBytes).toBe(10 ** 12);
  });

  it("guards the runs dimension while still ticking artifactCount alongside artifactBytes", async () => {
    for (let i = 0; i < 3; i++) {
      const applied = await usageGuardedBumpStatement(
        "team-1",
        PERIOD,
        { runs: 1 },
        { dimension: "runs", limit: 3 },
        NOW,
        EXEC,
      );
      expect(applied).toHaveLength(1);
    }
    const rejected = await usageGuardedBumpStatement(
      "team-1",
      PERIOD,
      { runs: 1 },
      { dimension: "runs", limit: 3 },
      NOW,
      EXEC,
    );
    expect(rejected).toHaveLength(0);
    expect((await readCounter("team-1"))?.runsCount).toBe(3);
  });
});

describe("reconcileUsage — corrects drift and preserves snapshot deltas", () => {
  it("lowers a stale counter to the recomputed row count", async () => {
    await h.db.insert(teams).values({
      id: "team-1",
      slug: "team-1",
      name: "Team One",
      tier: "free",
      createdAt: NOW,
    } as never);
    await usageBumpStatement("team-1", PERIOD, { runs: 5 }, NOW, EXEC);
    for (let i = 0; i < 2; i++) {
      await h.db.insert(runs).values({
        id: `run-${i}`,
        teamId: "team-1",
        projectId: "proj-1",
        idempotencyKey: `run-${i}`,
        totalTests: 0,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 0,
        status: "running",
        origin: "ci",
        createdAt: NOW,
        lastActivityAt: NOW,
      } as never);
    }

    await reconcileUsage(NOW);

    expect((await readCounter("team-1"))?.runsCount).toBe(2);
  });

  it("carries a post-snapshot increment onto the recomputed count", async () => {
    await usageBumpStatement("team-1", PERIOD, { runs: 5 }, NOW, EXEC);

    await reconcileUsageCounterRowStatement(
      {
        id: "reconciled-row",
        teamId: "team-1",
        periodStart: PERIOD,
        runsCount: 2,
        artifactBytes: 0,
        artifactCount: 0,
        updatedAt: NOW + 1,
      },
      {
        runsCount: 4,
        artifactBytes: 0,
        artifactCount: 0,
      },
      EXEC,
    );

    expect((await readCounter("team-1"))?.runsCount).toBe(3);
  });
});
