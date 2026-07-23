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
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

// `void/db` → the harness instance, with the REAL Drizzle operators.
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

// `getUserIdentity` normally reads the void-owned `user`/`account` tables (not
// in this minimal harness); stub it to a deterministic identity keyed off the
// userId. The REAL `buildInviteMatchConds` (kept via importActual) builds its
// email-eq condition against the real `teamInvites` columns.
vi.mock("@/lib/auth-users", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("@/lib/auth-users");
  return {
    ...actual,
    getUserIdentity: (userId: string) =>
      Promise.resolve({
        // "u-noemail" models an unverified/absent email → no addressing → 403.
        email: userId === "u-noemail" ? null : `${userId}@ex.com`,
        githubLogin: null,
      }),
  };
});

// Audit writes to a table this harness doesn't create; no-op it (keep the real
// AUDIT_ACTIONS constant the module reads).
vi.mock("@/lib/audit", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/audit");
  return { ...actual, recordAudit: () => Promise.resolve() };
});

const { resetTables } = await import("./harness");
const { acceptDirectedInvite } = await import("@/lib/invites");
const { memberships, teamInvites, teams } = await import("../../../db/schema");
const { and, eq } = await import("void/_db");

// `acceptDirectedInvite` validates `expiresAt` against the REAL wall clock
// (`Date.now()`), so these must straddle actual now — not a fixed epoch — or the
// outer expiry gate would mask the paths under test. Far-future / far-past
// sentinels keep the suite clock-independent.
const NOW = 1_700_000_000; // seed createdAt only (never compared to wall clock)
const FUTURE = 9_999_999_999; // year 2286 — unexpired under any real run date
const PAST = 1; // 1970 — always expired

// `acceptDirectedInvite`'s `c` is only forwarded to the (mocked) recordAudit.
const ctx = {} as Parameters<typeof acceptDirectedInvite>[0];

beforeAll(async () => {
  await resetTables(h.client, [teams, teamInvites, memberships]);
  // resetTables omits indexes (harness.ts), but the idempotent-accept path
  // depends on the REAL unique index firing a 23505 — recreate it explicitly.
  await h.client.exec(
    'create unique index "memberships_user_team_idx" on "memberships" ("userId", "teamId");',
  );
});

afterAll(async () => {
  await h.client.close();
});

beforeEach(async () => {
  await h.db.delete(memberships);
  await h.db.delete(teamInvites);
  await h.db.delete(teams);
  vi.restoreAllMocks();
});

async function seedTeam(id: string, slug: string) {
  await h.db.insert(teams).values({
    id,
    slug,
    name: slug,
    tier: "free",
    createdAt: NOW,
  });
}

async function seedInvite(
  id: string,
  teamId: string,
  addresseeUserId: string,
  expiresAt: number,
) {
  await h.db.insert(teamInvites).values({
    id,
    teamId,
    tokenHash: `hash-${id}`,
    role: "member",
    createdBy: "u-inviter",
    createdAt: NOW,
    expiresAt,
    email: `${addresseeUserId}@ex.com`,
  });
}

async function membershipCount(userId: string, teamId: string) {
  const rows = await h.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)));
  return rows.length;
}

async function inviteExists(id: string) {
  const rows = await h.db
    .select({ id: teamInvites.id })
    .from(teamInvites)
    .where(eq(teamInvites.id, id));
  return rows.length > 0;
}

describe("acceptDirectedInvite", () => {
  it("happy path: creates the membership, consumes the invite, returns the team", async () => {
    await seedTeam("t1", "acme");
    await seedInvite("inv1", "t1", "u1", FUTURE);

    const res = await acceptDirectedInvite(ctx, "u1", "inv1");

    expect(res).toEqual({ ok: true, teamId: "t1", teamSlug: "acme" });
    expect(await membershipCount("u1", "t1")).toBe(1);
    expect(await inviteExists("inv1")).toBe(false);
  });

  it("idempotent accept: an already-member user's insert hits the unique index (23505) and is treated as success", async () => {
    await seedTeam("t2", "beta");
    // Pre-existing membership: models a prior join or a concurrent accept of a
    // different invite that already inserted the (u2, t2) row.
    await h.db.insert(memberships).values({
      id: "m-existing",
      userId: "u2",
      teamId: "t2",
      role: "member",
      createdAt: NOW,
    });
    await seedInvite("inv2", "t2", "u2", FUTURE);

    const res = await acceptDirectedInvite(ctx, "u2", "inv2");

    // No 500 — the 23505 is caught and reported as an idempotent success.
    expect(res).toEqual({ ok: true, teamId: "t2", teamSlug: "beta" });
    // Still exactly one membership (no duplicate), and the invite is consumed.
    expect(await membershipCount("u2", "t2")).toBe(1);
    expect(await inviteExists("inv2")).toBe(false);
  });

  it("revoked between read and write: an invite deleted in the SELECT→write window grants NO membership (in-transaction re-check)", async () => {
    await seedTeam("t3", "gamma");
    await seedInvite("inv3", "t3", "u3", FUTURE);

    // Simulate a concurrent revoke landing after the validating SELECT but
    // before the write transaction: delete the invite just before the real
    // transaction runs. The transaction's `DELETE ... RETURNING` then finds
    // nothing → the membership insert is gated out.
    const realTx = h.db.transaction.bind(h.db);
    vi.spyOn(h.db, "transaction").mockImplementationOnce(((
      cb: (tx: unknown) => Promise<unknown>,
    ) =>
      h.db
        .delete(teamInvites)
        .where(eq(teamInvites.id, "inv3"))
        .then(() => realTx(cb as never))) as never);

    const res = await acceptDirectedInvite(ctx, "u3", "inv3");

    expect(res).toEqual({
      ok: false,
      status: 404,
      error: "Invite not found or expired",
    });
    // The revoked invite could NOT be redeemed via the race.
    expect(await membershipCount("u3", "t3")).toBe(0);
  });

  it("expired invite is not redeemable (404, no membership)", async () => {
    await seedTeam("t4", "delta");
    await seedInvite("inv4", "t4", "u4", PAST);

    const res = await acceptDirectedInvite(ctx, "u4", "inv4");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(await membershipCount("u4", "t4")).toBe(0);
    // An expired invite still exists (GC is the sweep cron's job, not accept's).
    expect(await inviteExists("inv4")).toBe(true);
  });

  it("an invite addressed to a different email is not redeemable (404)", async () => {
    await seedTeam("t5", "epsilon");
    // Addressed to u-other, but u5 accepts.
    await seedInvite("inv5", "t5", "u-other", FUTURE);

    const res = await acceptDirectedInvite(ctx, "u5", "inv5");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(await membershipCount("u5", "t5")).toBe(0);
  });

  it("a user with no verified email cannot redeem a directed invite (403)", async () => {
    await seedTeam("t6", "zeta");
    await seedInvite("inv6", "t6", "u-noemail", FUTURE);

    const res = await acceptDirectedInvite(ctx, "u-noemail", "inv6");

    expect(res).toEqual({
      ok: false,
      status: 403,
      error: "Invite not addressed to this account",
    });
    expect(await membershipCount("u-noemail", "t6")).toBe(0);
  });
});
