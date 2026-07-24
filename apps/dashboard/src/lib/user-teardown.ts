import { and, count, db, eq, inArray } from "void/db";
import {
  memberGroupMembers,
  memberships,
  userGithubAccounts,
  userState,
} from "@schema";
import { logger } from "void/log";
import { runBatch } from "@/lib/db/batch";

/**
 * Cleanup for the Better Auth `user.deleteUser` flow (wired in `auth.ts`).
 *
 * The Better Auth `user`/`session`/`account`/`verification` tables are owned by
 * void/auth and cascade on user delete via that runner. But OUR user-referencing
 * rows use LOGICAL FKs (no `.references()` across the auth-boundary — see the
 * schema header), so nothing cleans them up when a user is deleted. This module
 * closes that gap: a sole-owner guard (`assertUserDeletable`) that runs BEFORE
 * the delete and a row sweep (`cleanupUserData`) that runs AFTER.
 *
 * Deliberately app-level, not FKs: the sole-owner rule needs logic a
 * `references()` can't express (a cascade would silently strand a team whose
 * only owner is the deleted user). `createdBy` / `actorUserId` columns are NOT
 * swept — those rows (audit log, monitors, quarantine) must OUTLIVE the user as
 * an opaque historical label, same principle as the audit-log project FK.
 */

/** Message surfaced when the sole-owner guard blocks a deletion. */
export const SOLE_OWNER_DELETE_MESSAGE =
  "Cannot delete your account while you are the sole owner of one or more teams. Transfer ownership or delete those teams first.";

/**
 * Team ids for which `userId` is the ONLY `owner`. Two queries (no N+1): the
 * user's owner memberships, then the owner-count for each of those teams; a
 * count of 1 means removing this user would leave the team ownerless.
 */
export async function findSoleOwnerTeamIds(userId: string): Promise<string[]> {
  const ownerOf = await db
    .select({ teamId: memberships.teamId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.role, "owner")));
  if (ownerOf.length === 0) return [];
  const teamIds = ownerOf.map((r) => r.teamId);

  const counts = await db
    .select({ teamId: memberships.teamId, owners: count() })
    .from(memberships)
    .where(
      and(inArray(memberships.teamId, teamIds), eq(memberships.role, "owner")),
    )
    .groupBy(memberships.teamId);

  return counts.filter((r) => r.owners <= 1).map((r) => r.teamId);
}

/**
 * Throw if deleting `userId` would strand a team (they are its sole owner).
 * Wired as the `deleteUser.beforeDelete` hook, so it aborts the delete before
 * any auth row is removed. A plain `Error` is enough — Better Auth propagates it
 * and the delete does not proceed.
 */
export async function assertUserDeletable(userId: string): Promise<void> {
  const stranded = await findSoleOwnerTeamIds(userId);
  if (stranded.length > 0) throw new Error(SOLE_OWNER_DELETE_MESSAGE);
}

/**
 * Sweep every row that logically references `userId` in ONE atomic batch. Runs
 * as the `deleteUser.afterDelete` hook (post-guard), so by here the user is
 * provably not a sole owner and dropping their memberships strands nothing.
 *
 * Best-effort, like `recordAudit`: this is the `afterDelete` hook, so the auth
 * `user` row is already gone by the time it runs — a rejection can only surface
 * a spurious 500 for an account deletion that already succeeded (Better Auth
 * won't roll it back). A failed batch is therefore logged (`logger.error`, so it
 * surfaces in Cloudflare Tail) and swallowed; the un-swept rows are harmless
 * reconcilable orphans (they carry no cascading FK and reference a now-gone id).
 */
export async function cleanupUserData(userId: string): Promise<void> {
  try {
    await runBatch((tx) => [
      tx.delete(memberships).where(eq(memberships.userId, userId)),
      tx
        .delete(memberGroupMembers)
        .where(eq(memberGroupMembers.userId, userId)),
      tx.delete(userState).where(eq(userState.userId, userId)),
      tx
        .delete(userGithubAccounts)
        .where(eq(userGithubAccounts.userId, userId)),
    ]);
  } catch (err) {
    logger.error("cleanupUserData failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
