// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

const { resetTables } = await import("./harness");
const { createGroup, listGroups, listUserIdsInGroups, updateGroup } =
  await import("@/lib/member-groups");
const { removeMemberGuarded } = await import("@/lib/members-repo");
const { memberGroupMembers, memberGroups, memberships, teams } =
  await import("../../../db/schema");
const { eq } = await import("void/_db");

beforeAll(async () => {
  await resetTables(h.client, [
    teams,
    memberships,
    memberGroups,
    memberGroupMembers,
  ]);
  await h.client.exec(
    `alter table "memberGroupMembers" add constraint "test_no_explode" check ("userId" <> 'explode')`,
  );
  await h.db.insert(teams).values({
    id: "t1",
    slug: "one",
    name: "One",
    tier: "free",
    createdAt: 1,
  });
  await h.db.insert(memberships).values([
    {
      id: "m-old",
      userId: "old",
      teamId: "t1",
      role: "member",
      createdAt: 1,
    },
    {
      id: "m-explode",
      userId: "explode",
      teamId: "t1",
      role: "member",
      createdAt: 1,
    },
  ]);
  await h.db.insert(memberGroups).values({
    id: "g1",
    teamId: "t1",
    name: "Original",
    createdBy: "owner",
    createdAt: 1,
    updatedAt: 1,
  });
  await h.db.insert(memberGroupMembers).values({
    groupId: "g1",
    userId: "old",
  });
});

afterAll(async () => {
  await h.client.close();
});

describe("updateGroup", () => {
  it("rolls back the rename when member replacement fails", async () => {
    await expect(
      updateGroup("t1", "g1", "Renamed", ["explode"], 2),
    ).rejects.toThrow();

    const group = await h.db
      .select({ name: memberGroups.name, updatedAt: memberGroups.updatedAt })
      .from(memberGroups)
      .where(eq(memberGroups.id, "g1"));
    const links = await h.db
      .select({ userId: memberGroupMembers.userId })
      .from(memberGroupMembers)
      .where(eq(memberGroupMembers.groupId, "g1"));

    expect(group[0]).toEqual({ name: "Original", updatedAt: 1 });
    expect(links).toEqual([{ userId: "old" }]);
  });

  it("removes normal links and excludes exceptional logical orphans", async () => {
    await expect(removeMemberGuarded("t1", "old")).resolves.toEqual({
      ok: true,
    });
    expect(
      await h.db
        .select({ userId: memberGroupMembers.userId })
        .from(memberGroupMembers)
        .where(eq(memberGroupMembers.groupId, "g1")),
    ).toEqual([]);

    await h.db.insert(memberGroupMembers).values({
      groupId: "g1",
      userId: "orphan",
    });
    expect(await listGroups("t1")).toEqual([
      {
        id: "g1",
        name: "Original",
        memberIds: [],
      },
    ]);
    expect(await listUserIdsInGroups("t1", ["g1"])).toEqual([]);
  });
});

describe("createGroup", () => {
  it("returns null instead of raising when the team is already torn down", async () => {
    // A missing `teams` row is what the parent key-share lock sees once
    // teardown commits. `updateGroup` already reports that as `false`; the
    // create path must not present it as a retryable save failure.
    await expect(
      createGroup("t-gone", "Ghosts", ["old"], "owner", 3),
    ).resolves.toBeNull();
    expect(
      await h.db
        .select({ id: memberGroups.id })
        .from(memberGroups)
        .where(eq(memberGroups.teamId, "t-gone")),
    ).toEqual([]);
  });
});
