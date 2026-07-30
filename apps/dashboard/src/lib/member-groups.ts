/**
 * Repository for `memberGroups` — named, team-scoped sets of members (see the
 * schema doc-comment). All reads/writes are scoped by `teamId` so a caller can
 * never touch another team's groups. The edit flow atomically renames and
 * replaces the complete member set, always intersecting posted ids with the
 * team's CURRENT members.
 */
import { and, db, eq, inArray } from "void/db";
import { ulid } from "ulid";
import { memberGroupMembers, memberGroups, memberships } from "@schema";
import type { BatchExecutor } from "@/lib/db/batch";
import { lockOwnerRows } from "@/lib/members-repo";
import { lockTeamForChildMutation } from "@/lib/team-lock";

export interface MemberGroupSummary {
  id: string;
  name: string;
  memberIds: string[];
}

/** All groups for a team, each with its member ids, sorted alphabetically by name. */
export async function listGroups(
  teamId: string,
): Promise<MemberGroupSummary[]> {
  const groups = await db
    .select({ id: memberGroups.id, name: memberGroups.name })
    .from(memberGroups)
    .where(eq(memberGroups.teamId, teamId))
    .orderBy(memberGroups.name);
  if (groups.length === 0) return [];

  const links = await db
    .select({
      groupId: memberGroupMembers.groupId,
      userId: memberGroupMembers.userId,
    })
    .from(memberGroupMembers)
    .innerJoin(
      memberships,
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.userId, memberGroupMembers.userId),
      ),
    )
    .where(
      inArray(
        memberGroupMembers.groupId,
        groups.map((g) => g.id),
      ),
    );
  const byGroup = new Map<string, string[]>();
  for (const l of links) {
    const list = byGroup.get(l.groupId) ?? [];
    list.push(l.userId);
    byGroup.set(l.groupId, list);
  }
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: byGroup.get(g.id) ?? [],
  }));
}

/** Distinct user ids belonging to any of `groupIds` within the team. */
export async function listUserIdsInGroups(
  teamId: string,
  groupIds: string[],
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({ userId: memberGroupMembers.userId })
    .from(memberGroupMembers)
    .innerJoin(memberGroups, eq(memberGroups.id, memberGroupMembers.groupId))
    .innerJoin(
      memberships,
      and(
        eq(memberships.teamId, memberGroups.teamId),
        eq(memberships.userId, memberGroupMembers.userId),
      ),
    )
    .where(
      and(
        eq(memberGroups.teamId, teamId),
        inArray(memberGroupMembers.groupId, groupIds),
      ),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Create a group and set its initial members (intersected with live members).
 * Returns the new id, or null when concurrent team teardown already removed the
 * parent — the same "already gone" outcome {@link updateGroup} reports as
 * `false`, not a retryable failure.
 */
export async function createGroup(
  teamId: string,
  name: string,
  userIds: string[],
  createdBy: string,
  now: number,
): Promise<string | null> {
  const id = ulid();
  const created = await db.transaction(async (tx) => {
    if (!(await lockTeamForChildMutation(tx, teamId))) return false;
    await tx.insert(memberGroups).values({
      id,
      teamId,
      name,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    await replaceMembers(tx, teamId, id, userIds);
    return true;
  });
  return created ? id : null;
}

/** Atomically rename a group and replace its complete member set. */
export async function updateGroup(
  teamId: string,
  groupId: string,
  name: string,
  userIds: string[],
  now: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockTeamForChildMutation(tx, teamId))) return false;
    const renamed = await tx
      .update(memberGroups)
      .set({ name, updatedAt: now })
      .where(and(eq(memberGroups.id, groupId), eq(memberGroups.teamId, teamId)))
      .returning({ id: memberGroups.id });
    if (renamed.length === 0) return false;
    await replaceMembers(tx, teamId, groupId, userIds);
    return true;
  });
}

/** Delete a group (its membership rows cascade). */
export async function deleteGroup(
  teamId: string,
  groupId: string,
): Promise<void> {
  await db
    .delete(memberGroups)
    .where(and(eq(memberGroups.id, groupId), eq(memberGroups.teamId, teamId)));
}

/**
 * Wholesale-replace a group's membership with the intersection of `userIds` and
 * the team's CURRENT members — so a stale/non-member id is never stored.
 */
async function replaceMembers(
  exec: BatchExecutor,
  teamId: string,
  groupId: string,
  userIds: string[],
): Promise<void> {
  // Member removal locks owners before its target row. Take that same prefix
  // lock before locking the full live set, otherwise an update holding a
  // low-sorting non-owner while waiting for an owner can deadlock with a remove
  // holding that owner while waiting for the non-owner. Once these locks land,
  // a concurrent remove/leave must wait; after this transaction commits it
  // removes any departing member's links. If removal wins first, this read
  // resumes without that member and cannot recreate the link.
  await lockOwnerRows(exec, teamId);
  const liveRows = await exec
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.teamId, teamId))
    .orderBy(memberships.id)
    .for("update");
  const liveIds = new Set(liveRows.map((m) => m.userId));
  const valid = [...new Set(userIds)].filter((id) => liveIds.has(id));
  await exec
    .delete(memberGroupMembers)
    .where(eq(memberGroupMembers.groupId, groupId));
  if (valid.length > 0) {
    await exec
      .insert(memberGroupMembers)
      .values(valid.map((userId) => ({ groupId, userId })));
  }
}
