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
import type { Order } from "@polar-sh/sdk/models/components/order";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";

/**
 * Members (last-owner guard) + billing-mirror integration — split out of the
 * former monolithic `pg-integration.test.ts` (see
 * docs/worklog/2026-07-11-split-pg-integration-tests.md). This file owns two
 * adjacent auth/tenancy domains that share the `memberships` + `teams` tables:
 * the auth-boundary user-teardown sweep (`findSoleOwnerTeamIds` /
 * `assertUserDeletable` / `cleanupUserData`) and `members-repo`'s last-owner
 * guard functional shape, plus the Polar billing mirror end-to-end (quota
 * gating, tier classification, reconcile, and every webhook → mirror writer)
 * — executed against the real schema (pglite by default, real node-postgres
 * under PG_TEST_URL). See `./harness.ts` for the shared hoisted-mock boot
 * dance.
 */

// Build the backing Drizzle instance BEFORE any import of the modules under
// test resolves `void/db` (vi.hoisted runs first).
const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

// `void/db` → the harness instance, with the REAL Drizzle operators (incl.
// `sql`) from the non-intercepted `void/_db` entry.
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

// Mocked for consistency with the rest of this directory (unused here,
// harmless).
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

// The billing tests below need `void/env` (the node lane aliases it to an
// EMPTY stub, so the gating functions would otherwise see no caps +
// billing-off) and `@polar-sh/sdk` (the reconcile network boundary). Both
// back onto hoisted mutables so each test drives billing-on/off + the
// synthetic Polar `subscriptions.list` page.
const { billingConfig, polarStub } = vi.hoisted(() => ({
  billingConfig: {} as Record<string, unknown>,
  polarStub: { items: [] as unknown[] },
}));
vi.mock("void/env", () => ({ env: billingConfig }));
vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    subscriptions = {
      // `subscriptions.list` returns a PageIterator — an async-iterable of
      // pages — so reconcile consumes it with `for await`.
      list: () =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield { result: { items: polarStub.items } };
          },
        }),
    };
  },
}));

const { resetTables } = await import("./harness");
const { assertUserDeletable, cleanupUserData, findSoleOwnerTeamIds } =
  await import("@/lib/user-teardown");
const { setMemberRole } = await import("@/lib/members-repo");
const {
  artifacts,
  memberGroupMembers,
  memberships,
  projects,
  runs,
  teams,
  usageCounters,
  userGithubAccounts,
  userState,
} = await import("../../../db/schema");
const { eq } = await import("void/_db");

// Billing modules under test (imported via `await import` so the void/db +
// void/env + @polar-sh/sdk mocks apply).
const { checkQuota, monthStartSeconds, reconcileUsage } =
  await import("@/lib/usage");
const { effectiveTier, BILLING_PERIOD_GRACE_SECONDS } =
  await import("@/lib/billing/tier");
const { loadTeamBilling } = await import("@/lib/billing/subscription");
const { reconcileBilling } = await import("@/lib/billing/reconcile");
const {
  onSubscriptionActive,
  onSubscriptionCanceled,
  onSubscriptionRevoked,
  onOrderPaid,
} = await import("@/lib/billing/polar-webhook");

beforeAll(async () => {
  await resetTables(h.client, [
    teams,
    usageCounters,
    memberships,
    memberGroupMembers,
    userState,
    userGithubAccounts,
    projects,
    runs,
    artifacts,
  ]);
  // `resetTables`/`createTableSql` deliberately omit indexes (see harness.ts),
  // but `reconcileUsage`'s bulk `onConflictDoUpdate` needs a REAL unique
  // constraint on (teamId, periodStart) to plan the ON CONFLICT target
  // against — Postgres rejects the statement otherwise ("no unique or
  // exclusion constraint matching the ON CONFLICT specification"). Scoped to
  // just this file's usageCounters table rather than a harness-wide change.
  await h.client.exec(
    'create unique index "usageCounters_team_period_idx" on "usageCounters" ("teamId", "periodStart");',
  );
});

afterAll(async () => {
  await h.client.close();
});

describe("user teardown (auth-boundary delete gap)", () => {
  const NOW = 1_700_000_000;

  beforeEach(async () => {
    await h.db.delete(memberships);
    await h.db.delete(memberGroupMembers);
    await h.db.delete(userState);
    await h.db.delete(userGithubAccounts);
  });

  function addMember(
    id: string,
    userId: string,
    teamId: string,
    role: "owner" | "member",
  ) {
    return h.db
      .insert(memberships)
      .values({ id, userId, teamId, role, createdAt: NOW });
  }

  it("findSoleOwnerTeamIds returns only teams where the user is the LONE owner", async () => {
    await addMember("m1", "u1", "team-solo", "owner"); // sole owner → stranded
    await addMember("m2", "u1", "team-co", "owner"); // co-owned → safe
    await addMember("m3", "u2", "team-co", "owner"); // the co-owner
    await addMember("m4", "u1", "team-member", "member"); // not an owner → safe
    expect(await findSoleOwnerTeamIds("u1")).toEqual(["team-solo"]);
    expect(await findSoleOwnerTeamIds("u2")).toEqual([]);
  });

  it("assertUserDeletable throws for a sole owner, resolves for a co-owner", async () => {
    await addMember("m1", "u1", "team-solo", "owner");
    await addMember("m2", "u1", "team-co", "owner");
    await addMember("m3", "u2", "team-co", "owner");
    await expect(assertUserDeletable("u1")).rejects.toThrow(/sole owner/i);
    await expect(assertUserDeletable("u2")).resolves.toBeUndefined();
  });

  it("cleanupUserData sweeps the user's rows in one batch, leaving others intact", async () => {
    await addMember("m1", "u1", "team-a", "member");
    await addMember("m2", "u2", "team-a", "owner"); // survivor
    await h.db.insert(memberGroupMembers).values([
      { groupId: "g1", userId: "u1" },
      { groupId: "g1", userId: "u2" },
    ]);
    await h.db.insert(userState).values({ userId: "u1", updatedAt: NOW });
    await h.db
      .insert(userGithubAccounts)
      .values({ userId: "u1", githubLogin: "octo", updatedAt: NOW });

    await cleanupUserData("u1");

    const u1 = async (
      table:
        | typeof memberships
        | typeof memberGroupMembers
        | typeof userState
        | typeof userGithubAccounts,
    ) => (await h.db.select().from(table).where(eq(table.userId, "u1"))).length;
    expect(await u1(memberships)).toBe(0);
    expect(await u1(memberGroupMembers)).toBe(0);
    expect(await u1(userState)).toBe(0);
    expect(await u1(userGithubAccounts)).toBe(0);
    // u2's rows are untouched.
    expect(
      await h.db.select().from(memberships).where(eq(memberships.userId, "u2")),
    ).toHaveLength(1);
    expect(
      await h.db
        .select()
        .from(memberGroupMembers)
        .where(eq(memberGroupMembers.userId, "u2")),
    ).toHaveLength(1);
  });
});

describe("members-repo (last-owner guard, functional against Postgres)", () => {
  // A dedicated team id, untouched by the "user teardown" suite above (whose
  // own beforeAll creates the `memberships` table this block relies on) — so
  // this can run after it without id/row collisions. True cross-transaction
  // CONCURRENCY (two owners racing to demote each other) can't be reproduced
  // against this single-connection test harness (pglite, or node-postgres
  // with `max: 1`); that race-closure guarantee is exercised by the
  // members-repo.workers.test.ts call-order assertions (the owner-row
  // `SELECT ... FOR UPDATE` firing before the guarded write). This only pins
  // the functional shape end-to-end: the lock-then-write transaction actually
  // runs against real Postgres semantics and produces the right outcomes.
  const RACE_TEAM = "team-race-lastowner";
  const NOW = 1_700_000_200;

  beforeEach(async () => {
    // Clean up our own rows first (re-run safety) — never the whole table.
    await h.db.delete(memberships).where(eq(memberships.teamId, RACE_TEAM));
  });

  it("demotes one of two co-owners, blocks demoting the sole remaining owner, and no-ops on a ghost user", async () => {
    await h.db.insert(memberships).values([
      {
        id: "mrace-owner-1",
        userId: "u-race-owner-1",
        teamId: RACE_TEAM,
        role: "owner",
        createdAt: NOW,
      },
      {
        id: "mrace-owner-2",
        userId: "u-race-owner-2",
        teamId: RACE_TEAM,
        role: "owner",
        createdAt: NOW,
      },
    ]);

    // Two owners: demoting one is safe.
    const demoteFirst = await setMemberRole(
      RACE_TEAM,
      "u-race-owner-1",
      "member",
    );
    expect(demoteFirst).toEqual({ ok: true });

    // One owner left: the guard (now behind the owner-row lock) blocks it.
    const demoteLast = await setMemberRole(
      RACE_TEAM,
      "u-race-owner-2",
      "member",
    );
    expect(demoteLast).toEqual({ ok: false, reason: "lastOwner" });

    // A user who was never a member of this team: noop, not lastOwner.
    const demoteGhost = await setMemberRole(
      RACE_TEAM,
      "u-race-ghost",
      "member",
    );
    expect(demoteGhost).toEqual({ ok: false, reason: "noop" });
  });
});

const BNOW = 1_700_000_000;

// Synthetic webhook payloads. The handlers read only these fields (fact 10); the
// `as unknown as` cast matches this file's existing convention for partial
// driver/SDK shapes.
function makeSubscription(o: {
  id: string;
  customerId: string;
  status: string;
  referenceId?: string;
  modifiedAt: Date | null;
  createdAt: Date;
  currentPeriodEnd: Date;
}): { data: Subscription } {
  return {
    data: {
      id: o.id,
      customerId: o.customerId,
      status: o.status,
      createdAt: o.createdAt,
      modifiedAt: o.modifiedAt,
      currentPeriodEnd: o.currentPeriodEnd,
      metadata: o.referenceId ? { referenceId: o.referenceId } : {},
    } as unknown as Subscription,
  };
}

function makeOrder(o: {
  id: string;
  customerId: string;
  referenceId?: string;
  modifiedAt: Date | null;
  createdAt: Date;
  periodEnd: Date;
}): { data: Order } {
  return {
    data: {
      id: o.id,
      customerId: o.customerId,
      createdAt: o.createdAt,
      modifiedAt: o.modifiedAt,
      metadata: o.referenceId ? { referenceId: o.referenceId } : {},
      subscription: { currentPeriodEnd: o.periodEnd },
    } as unknown as Order,
  };
}

describe("Polar billing mirror (Postgres path)", () => {
  beforeEach(async () => {
    // Billing ON with known caps; tests that need billing OFF delete POLAR_*.
    billingConfig.POLAR_ACCESS_TOKEN = "polar_test";
    billingConfig.POLAR_WEBHOOK_SECRET = "whsec_test";
    billingConfig.POLAR_MODE = "sandbox";
    billingConfig.WRIGHTFUL_FREE_MONTHLY_RUNS = 1000;
    billingConfig.WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS = 100000;
    billingConfig.WRIGHTFUL_FREE_ARTIFACT_BYTES = 5_368_709_120;
    billingConfig.WRIGHTFUL_PRO_MONTHLY_RUNS = 25000;
    billingConfig.WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS = 5_000_000;
    billingConfig.WRIGHTFUL_PRO_ARTIFACT_BYTES = 107_374_182_400;
    billingConfig.WRIGHTFUL_QUOTA_SOFT_WARN_PCT = 90;
    polarStub.items = [];
    // Clean slate (these tables carry no FK in the test DDL, so order is free).
    await h.db.delete(usageCounters);
    await h.db.delete(teams);
  });

  it("round-trips the bigint billing-mirror columns as numbers (int8 parity)", async () => {
    await h.db.insert(teams).values({
      id: "bt-mirror",
      slug: "mirror",
      name: "Mirror",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_1",
      polarSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      currentPeriodEnd: 1_900_000_000,
      billingUpdatedAt: 1_850_000_000,
    });
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "bt-mirror"));
    expect(typeof row?.currentPeriodEnd).toBe("number");
    expect(row?.currentPeriodEnd).toBe(1_900_000_000);
    expect(typeof row?.billingUpdatedAt).toBe("number");
    expect(row?.billingUpdatedAt).toBe(1_850_000_000);
    expect(row?.polarCustomerId).toBe("cus_1");
  });

  it("checkQuota gates a within-period pro at the FINITE Pro ceiling (billing ON)", async () => {
    const periodStart = monthStartSeconds(BNOW);
    await h.db.insert(teams).values({
      id: "bt-pro",
      slug: "pro",
      name: "Pro",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_pro",
      currentPeriodEnd: BNOW + 100_000,
    });
    let res = await checkQuota("bt-pro", "runs", 1, BNOW);
    expect(res.status).toBe("ok");
    expect(res.limit).toBe(25000); // finite Pro cap, NOT Infinity
    await h.db.insert(usageCounters).values({
      id: "uc-pro",
      teamId: "bt-pro",
      periodStart,
      runsCount: 25000,
      artifactBytes: 0,
      artifactCount: 0,
      updatedAt: BNOW,
    });
    res = await checkQuota("bt-pro", "runs", 1, BNOW);
    expect(res.status).toBe("blocked"); // 25001 > 25000
  });

  it("checkQuota re-caps an EXPIRED pro to the free ceiling (D9 expiry gate, billing ON)", async () => {
    const periodStart = monthStartSeconds(BNOW);
    await h.db.insert(teams).values({
      id: "bt-exp",
      slug: "exp",
      name: "Exp",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_exp",
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100, // past grace
    });
    await h.db.insert(usageCounters).values({
      id: "uc-exp",
      teamId: "bt-exp",
      periodStart,
      runsCount: 1000,
      artifactBytes: 0,
      artifactCount: 0,
      updatedAt: BNOW,
    });
    const res = await checkQuota("bt-exp", "runs", 1, BNOW);
    expect(res.limit).toBe(1000); // effective tier free
    expect(res.status).toBe("blocked"); // 1001 > 1000
  });

  it("checkQuota is UNLIMITED for every tier when billing is OFF (the only uncapped path)", async () => {
    delete billingConfig.POLAR_ACCESS_TOKEN;
    delete billingConfig.POLAR_WEBHOOK_SECRET;
    const periodStart = monthStartSeconds(BNOW);
    await h.db.insert(teams).values({
      id: "bt-free",
      slug: "free",
      name: "Free",
      tier: "free",
      createdAt: BNOW,
    });
    await h.db.insert(usageCounters).values({
      id: "uc-free",
      teamId: "bt-free",
      periodStart,
      runsCount: 10_000_000,
      artifactBytes: 0,
      artifactCount: 0,
      updatedAt: BNOW,
    });
    const res = await checkQuota("bt-free", "runs", 1, BNOW);
    expect(res.limit).toBe(Infinity);
    expect(res.status).toBe("ok"); // far past the free ceiling, but unlimited
  });

  it("loadTeamBilling classifies free / trial / paid", async () => {
    await h.db.insert(teams).values([
      { id: "b-free", slug: "f", name: "F", tier: "free", createdAt: BNOW },
      {
        id: "b-trial",
        slug: "t",
        name: "T",
        tier: "pro",
        createdAt: BNOW,
        currentPeriodEnd: BNOW + 100_000,
        polarCustomerId: null,
      },
      {
        id: "b-paid",
        slug: "p",
        name: "P",
        tier: "pro",
        createdAt: BNOW,
        currentPeriodEnd: BNOW + 100_000,
        polarCustomerId: "cus_paid",
        subscriptionStatus: "active",
      },
    ]);
    expect((await loadTeamBilling("b-free", BNOW)).state).toBe("free");
    const trial = await loadTeamBilling("b-trial", BNOW);
    expect(trial.state).toBe("trial");
    expect(trial.trialDaysLeft).not.toBeNull();
    expect((await loadTeamBilling("b-paid", BNOW)).state).toBe("paid");
  });

  it("trial seed shape: tier=pro + ~14d period + null customer re-caps to free after grace", async () => {
    // Equivalent to createTeamForUser's seed (PR 4). createTeamForUser also inserts
    // a membership row (table not created in this minimal harness), so we assert
    // the seeded VALUES + the gating consequence here.
    const TRIAL = 14 * 24 * 60 * 60;
    await h.db.insert(teams).values({
      id: "b-seed",
      slug: "seed",
      name: "Seed",
      tier: "pro",
      createdAt: BNOW,
      currentPeriodEnd: BNOW + TRIAL,
      polarCustomerId: null,
    });
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-seed"));
    expect(row?.tier).toBe("pro");
    expect(row?.polarCustomerId).toBeNull();
    expect(row?.currentPeriodEnd).toBe(BNOW + TRIAL);
    expect(effectiveTier("pro", BNOW + TRIAL, BNOW)).toBe("pro");
    expect(
      effectiveTier(
        "pro",
        BNOW + TRIAL,
        BNOW + TRIAL + BILLING_PERIOD_GRACE_SECONDS + 1,
      ),
    ).toBe("free");
  });

  it("reconcile downgrades an expired pro whose Polar subscription is gone", async () => {
    polarStub.items = []; // no active subscription
    await h.db.insert(teams).values({
      id: "b-rec",
      slug: "rec",
      name: "Rec",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec",
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100, // past grace
      billingUpdatedAt: 1_650_000_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary.checked).toBe(1);
    expect(summary.corrected).toBe(1);
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec"));
    expect(row?.tier).toBe("free");
  });

  it("reconcile leaves a within-period pro alone", async () => {
    polarStub.items = [];
    await h.db.insert(teams).values({
      id: "b-rec2",
      slug: "rec2",
      name: "Rec2",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec2",
      currentPeriodEnd: BNOW + 100_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary.corrected).toBe(0);
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec2"));
    expect(row?.tier).toBe("pro");
  });

  it("reconcile prefers an ACTIVE subscription over an earlier non-active one in the paged results (M2)", async () => {
    // A stale canceled subscription is ordered BEFORE the current active one —
    // picking page.result.items[0] blindly (the old bug) would misclassify this
    // paying customer as free and wrongly downgrade them.
    polarStub.items = [
      {
        id: "sub_old",
        customerId: "cus_multi",
        status: "canceled",
        currentPeriodEnd: new Date((BNOW - 5_000_000) * 1000),
      } as unknown as Subscription,
      {
        id: "sub_new",
        customerId: "cus_multi",
        status: "active",
        currentPeriodEnd: new Date((BNOW + 200_000) * 1000),
      } as unknown as Subscription,
    ];
    await h.db.insert(teams).values({
      id: "b-rec-multi",
      slug: "rec-multi",
      name: "RecMulti",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_multi",
      // Past grace under the OLD currentPeriodEnd — the buggy items[0] pick
      // would read this customer as having no active subscription + expired,
      // and wrongly downgrade a paying customer.
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100,
    });
    const summary = await reconcileBilling(BNOW);
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "b-rec-multi"));
    expect(row?.tier).toBe("pro"); // NOT wrongly downgraded to free
    expect(row?.currentPeriodEnd).toBe(BNOW + 200_000); // refreshed from the active sub
    expect(summary.corrected).toBe(1);
  });

  it("reconcile refreshes a STALE currentPeriodEnd on an already-pro team (M3 — lost renewal webhook)", async () => {
    polarStub.items = [
      {
        id: "sub_renewed",
        customerId: "cus_renew",
        status: "active",
        // Polar has since renewed the subscription; assume the renewal webhook
        // was lost, so the row is still holding the PREVIOUS period's end.
        currentPeriodEnd: new Date((BNOW + 500_000) * 1000),
      } as unknown as Subscription,
    ];
    await h.db.insert(teams).values({
      id: "b-rec-stale-end",
      slug: "rec-stale-end",
      name: "RecStaleEnd",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_renew",
      // Stale but still within grace, so the tier never flips — the OLD code's
      // `t.tier !== desiredTier` gate would never fire and this field would
      // never get corrected.
      currentPeriodEnd: BNOW + 10_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary.corrected).toBe(1);
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "b-rec-stale-end"));
    expect(row?.tier).toBe("pro"); // tier unchanged
    expect(row?.currentPeriodEnd).toBe(BNOW + 500_000); // stale end IS refreshed
  });

  it("reconcile does NOT bump billingUpdatedAt (the ordering guard is webhook-owned)", async () => {
    polarStub.items = [];
    const STAMP = 1_650_000_000;
    await h.db.insert(teams).values({
      id: "b-rec3",
      slug: "rec3",
      name: "Rec3",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec3",
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100,
      billingUpdatedAt: STAMP,
    });
    await reconcileBilling(BNOW);
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec3"));
    expect(row?.tier).toBe("free"); // corrected
    expect(row?.billingUpdatedAt).toBe(STAMP); // but the guard is untouched
  });

  it("reconcile is a no-op (checked:0) when billing is OFF (POLAR_ACCESS_TOKEN unset)", async () => {
    delete billingConfig.POLAR_ACCESS_TOKEN;
    await h.db.insert(teams).values({
      id: "b-rec4",
      slug: "rec4",
      name: "Rec4",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec4",
      currentPeriodEnd: BNOW - 1_000_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary).toEqual({ checked: 0, corrected: 0 });
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec4"));
    expect(row?.tier).toBe("pro"); // untouched
  });

  it("onSubscriptionActive flips tier→pro + sets ids/period, stamping modifiedAt", async () => {
    await h.db.insert(teams).values({
      id: "b-wh",
      slug: "wh",
      name: "Wh",
      tier: "free",
      createdAt: BNOW,
    });
    await onSubscriptionActive(
      makeSubscription({
        id: "sub_a",
        customerId: "cus_a",
        status: "active",
        referenceId: "b-wh",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date((BNOW - 10) * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-wh"));
    expect(row?.tier).toBe("pro");
    expect(row?.polarCustomerId).toBe("cus_a");
    expect(row?.polarSubscriptionId).toBe("sub_a");
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.currentPeriodEnd).toBe(BNOW + 100_000);
    expect(row?.billingUpdatedAt).toBe(BNOW); // modifiedAt epoch
  });

  it("onSubscriptionRevoked downgrades tier→free and clears the subscription id", async () => {
    await h.db.insert(teams).values({
      id: "b-rev",
      slug: "rev",
      name: "Rev",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_r",
      polarSubscriptionId: "sub_r",
      subscriptionStatus: "active",
      currentPeriodEnd: BNOW + 100_000,
      billingUpdatedAt: BNOW - 100,
    });
    await onSubscriptionRevoked(
      makeSubscription({
        id: "sub_r",
        customerId: "cus_r",
        status: "canceled",
        referenceId: "b-rev",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rev"));
    expect(row?.tier).toBe("free");
    expect(row?.subscriptionStatus).toBe("revoked");
    expect(row?.polarSubscriptionId).toBeNull();
  });

  it("onSubscriptionCanceled is status-only (keeps tier=pro and the period)", async () => {
    await h.db.insert(teams).values({
      id: "b-can",
      slug: "can",
      name: "Can",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_c",
      currentPeriodEnd: BNOW + 100_000,
      billingUpdatedAt: BNOW - 100,
    });
    await onSubscriptionCanceled(
      makeSubscription({
        id: "sub_c",
        customerId: "cus_c",
        status: "canceled",
        referenceId: "b-can",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-can"));
    expect(row?.tier).toBe("pro"); // unchanged
    expect(row?.subscriptionStatus).toBe("canceled");
    expect(row?.currentPeriodEnd).toBe(BNOW + 100_000); // unchanged
  });

  it("onOrderPaid refreshes the period from subscription.currentPeriodEnd + keeps pro", async () => {
    await h.db.insert(teams).values({
      id: "b-ord",
      slug: "ord",
      name: "Ord",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_o",
      currentPeriodEnd: BNOW + 10,
      billingUpdatedAt: BNOW - 100,
    });
    await onOrderPaid(
      makeOrder({
        id: "ord_1",
        customerId: "cus_o",
        referenceId: "b-ord",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        periodEnd: new Date((BNOW + 200_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-ord"));
    expect(row?.tier).toBe("pro");
    expect(row?.currentPeriodEnd).toBe(BNOW + 200_000);
  });

  it("ordering guard: a stale active after a newer revoked stays free", async () => {
    await h.db.insert(teams).values({
      id: "b-guard",
      slug: "og",
      name: "OG",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_g",
      polarSubscriptionId: "sub_g",
      subscriptionStatus: "active",
      currentPeriodEnd: BNOW + 100_000,
      billingUpdatedAt: BNOW - 1000,
    });
    // Newer revoked (modifiedAt = BNOW) → free.
    await onSubscriptionRevoked(
      makeSubscription({
        id: "sub_g",
        customerId: "cus_g",
        status: "canceled",
        referenceId: "b-guard",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    // Stale active (older modifiedAt) → ignored.
    await onSubscriptionActive(
      makeSubscription({
        id: "sub_g",
        customerId: "cus_g",
        status: "active",
        referenceId: "b-guard",
        modifiedAt: new Date((BNOW - 500) * 1000),
        createdAt: new Date((BNOW - 500) * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "b-guard"));
    expect(row?.tier).toBe("free"); // the stale active did not resurrect pro
  });

  it("is idempotent: a duplicate active yields the same end state", async () => {
    await h.db.insert(teams).values({
      id: "b-idem",
      slug: "id",
      name: "Id",
      tier: "free",
      createdAt: BNOW,
    });
    const payload = makeSubscription({
      id: "sub_i",
      customerId: "cus_i",
      status: "active",
      referenceId: "b-idem",
      modifiedAt: new Date(BNOW * 1000),
      createdAt: new Date(BNOW * 1000),
      currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
    });
    await onSubscriptionActive(payload);
    await onSubscriptionActive(payload); // duplicate delivery
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-idem"));
    expect(row?.tier).toBe("pro");
    expect(row?.currentPeriodEnd).toBe(BNOW + 100_000);
    expect(row?.billingUpdatedAt).toBe(BNOW);
  });

  it("unresolved teamId (no metadata.referenceId) writes nothing", async () => {
    await h.db.insert(teams).values({
      id: "b-unres",
      slug: "un",
      name: "Un",
      tier: "free",
      createdAt: BNOW,
    });
    await onSubscriptionActive(
      makeSubscription({
        id: "sub_u",
        customerId: "cus_u",
        status: "active",
        // no referenceId → unresolved
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "b-unres"));
    expect(row?.tier).toBe("free"); // untouched (handler logged + returned)
  });
});

describe("reconcileUsage (set-based rebase, Postgres path)", () => {
  const RNOW = 1_700_000_500;
  const PERIOD = monthStartSeconds(RNOW);

  function runRow(
    id: string,
    teamId: string,
    projectId: string,
    createdAt: number,
  ) {
    return {
      id,
      teamId,
      projectId,
      totalTests: 1,
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 10,
      status: "passed",
      origin: "ci",
      createdAt,
      lastActivityAt: createdAt,
    };
  }

  function artifactRow(
    id: string,
    projectId: string,
    createdAt: number,
    sizeBytes: number,
  ) {
    return {
      id,
      projectId,
      testResultId: `tr-${id}`,
      type: "screenshot",
      name: "shot.png",
      contentType: "image/png",
      sizeBytes,
      r2Key: `key/${id}`,
      attempt: 0,
      createdAt,
    };
  }

  beforeEach(async () => {
    // Full wipe (this file's own tables, matching the "Polar billing mirror"
    // describe's pattern above) — files in this directory run serially
    // (`--no-file-parallelism` under PG_TEST_URL), so this can't race a
    // concurrent describe/file.
    await h.db.delete(artifacts);
    await h.db.delete(runs);
    await h.db.delete(usageCounters);
    await h.db.delete(projects);
    await h.db.delete(teams);
  });

  it("recomputes runsCount + artifact bytes/count per team from the authoritative rows, scoped by period + project", async () => {
    await h.db.insert(teams).values([
      { id: "rt-a", slug: "rt-a", name: "RT A", tier: "free", createdAt: RNOW },
      { id: "rt-b", slug: "rt-b", name: "RT B", tier: "free", createdAt: RNOW },
    ]);
    await h.db.insert(projects).values([
      { id: "rp-a1", teamId: "rt-a", slug: "a1", name: "A1", createdAt: RNOW },
      { id: "rp-b1", teamId: "rt-b", slug: "b1", name: "B1", createdAt: RNOW },
    ]);
    // team rt-a: 2 in-period runs + 1 before-period run (excluded).
    await h.db
      .insert(runs)
      .values([
        runRow("r-a1", "rt-a", "rp-a1", PERIOD + 10),
        runRow("r-a2", "rt-a", "rp-a1", PERIOD + 20),
        runRow("r-a-old", "rt-a", "rp-a1", PERIOD - 100),
      ]);
    // team rt-b: 1 in-period run, no artifacts.
    await h.db
      .insert(runs)
      .values([runRow("r-b1", "rt-b", "rp-b1", PERIOD + 5)]);
    // Only team rt-a has in-period artifacts; one before-period artifact is
    // excluded from both the byte sum and the count.
    await h.db
      .insert(artifacts)
      .values([
        artifactRow("art-a1", "rp-a1", PERIOD + 10, 1000),
        artifactRow("art-a2", "rp-a1", PERIOD + 20, 2000),
        artifactRow("art-a-old", "rp-a1", PERIOD - 100, 9_999_999),
      ]);

    const result = await reconcileUsage(RNOW);
    expect(result.teamsReconciled).toBe(2);

    const [a] = await h.db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.teamId, "rt-a"));
    expect(a?.runsCount).toBe(2);
    expect(a?.artifactBytes).toBe(3000);
    expect(a?.artifactCount).toBe(2);

    const [b] = await h.db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.teamId, "rt-b"));
    expect(b?.runsCount).toBe(1);
    expect(b?.artifactBytes).toBe(0);
    expect(b?.artifactCount).toBe(0);
  });

  it("corrects a stale counter above the recomputed row count", async () => {
    await h.db.insert(teams).values({
      id: "rt-stale",
      slug: "rt-stale",
      name: "Stale",
      tier: "free",
      createdAt: RNOW,
    });
    await h.db.insert(usageCounters).values({
      id: "uc-stale",
      teamId: "rt-stale",
      periodStart: PERIOD,
      runsCount: 500,
      artifactBytes: 123_456,
      artifactCount: 42,
      updatedAt: RNOW - 1000,
    });
    const result = await reconcileUsage(RNOW);
    expect(result.teamsReconciled).toBe(1);

    const [row] = await h.db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.teamId, "rt-stale"));
    expect(row?.runsCount).toBe(0);
    expect(row?.artifactBytes).toBe(0);
    expect(row?.artifactCount).toBe(0);
    expect(row?.updatedAt).toBe(RNOW);
  });
});
