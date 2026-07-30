import { eq } from "void/db";
import { teams } from "@schema";
import type { BatchExecutor } from "@/lib/db/batch";

/**
 * Take the parent-row lock that must prefix every transaction which mutates
 * team-owned children and can overlap whole-team deletion.
 *
 * A key-share lock lets independent child mutations proceed concurrently while
 * conflicting with the update lock used by team teardown. Taking it before any
 * project, invite, group, or membership lock establishes one global
 * parent-to-child order and prevents a child writer from holding a child row
 * while waiting behind teardown on the parent.
 *
 * Returns false when teardown already won and removed the team.
 */
export async function lockTeamForChildMutation(
  tx: BatchExecutor,
  teamId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("key share");
  return rows.length > 0;
}

/**
 * Lock the parent exclusively before snapshotting and cascading its children.
 * This conflicts with every {@link lockTeamForChildMutation} caller, making
 * team deletion a clean serialization boundary.
 */
export async function lockTeamForDeletion(
  tx: BatchExecutor,
  teamId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update");
  return rows.length > 0;
}
