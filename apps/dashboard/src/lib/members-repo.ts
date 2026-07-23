import { z } from "zod";
import { and, db, eq, ne, or, sql } from "void/db";
import { memberships, type MembershipRole } from "@schema";
import type { BatchExecutor } from "@/lib/db/batch";
import { ASSIGNABLE_ROLES } from "@/lib/roles";

/**
 * Membership mutations (roadmap 3.1: role editing + removal) and the one
 * invariant they all share: **a team must never be left with zero owners**.
 *
 * Two race shapes, closed by two mechanisms:
 *
 *  - **Same-row race**: carry the owner-count subquery INSIDE the UPDATE/DELETE
 *    WHERE (`notLastOwner`) instead of a separate check-then-write SELECT —
 *    guard and write are one atomic statement, so a blocked write matches 0 rows.
 *  - **Cross-row write skew**: the in-WHERE guard alone doesn't stop two owners
 *    demoting/removing EACH OTHER. Under Postgres READ COMMITTED, each
 *    statement's owner-count subquery re-reads at its own start, so both can
 *    see "2 owners" and commit, stranding the team ownerless. Closed by locking
 *    the owner rows first (`lockOwnerRows`, `SELECT ... FOR UPDATE`) inside a
 *    `db.transaction` before the guarded write on that same `tx`: the second
 *    caller blocks until the first commits, then sees the post-commit count.
 *    Same lock-then-write shape as `appendRunResults` in `src/lib/ingest.ts`.
 *
 * Callers read `.returning()` to detect a guard-blocked write and surface the
 * inline error. The role validator + guard live here (a tiny repo seam) so they
 * are shared by the members page action and the invite-mint API, and so the
 * guard's WHERE shape is unit-testable against the `void/db` stub.
 */

/**
 * Zod validator for a target membership role, narrowing an untrusted string to
 * a {@link MembershipRole}. The source list is {@link ASSIGNABLE_ROLES} (an
 * `as const` tuple) so the validator, the UI selector, and the invite schema
 * can't drift — and `z.enum` accepts the tuple directly, no cast.
 */
export const roleSchema = z.enum(ASSIGNABLE_ROLES);

/**
 * SQL predicate that is true unless flipping THIS row would strand the team
 * ownerless — i.e. the row is not the team's last owner. Reused verbatim by the
 * role-demote UPDATE and the member-remove DELETE.
 *
 * Reads as: the row is *not* an owner (demoting/removing a non-owner is always
 * safe) **OR** more than one owner exists on the team. When the acting row is
 * the sole owner, both arms are false and the write matches 0 rows.
 *
 * `teamId` is interpolated as a bound param (caller passes the
 * authz-resolved id); the literal `'owner'` is the stored role string. The
 * return type is whatever `or(...)` produces (drizzle's `SQL` expression) —
 * fed straight into `.where(and(..., notLastOwner(teamId)))`.
 */
export function notLastOwner(teamId: string) {
  return or(
    ne(memberships.role, "owner"),
    sql`(select count(*) from ${memberships} where ${memberships.teamId} = ${teamId} and ${memberships.role} = 'owner') > 1`,
  );
}

/**
 * Lock the team's owner rows (`SELECT ... FOR UPDATE`) so a concurrent
 * demote/remove/leave targeting a different owner row blocks until this
 * transaction commits — the module doc's "cross-row write skew" fix. Must be
 * the FIRST statement on `tx`, before the guarded write, on that same `tx` (a
 * lock on another connection serializes nothing). `orderBy(memberships.id)`
 * gives every caller the same lock-acquisition order, avoiding a lock-order
 * deadlock between racing peers.
 */
async function lockOwnerRows(tx: BatchExecutor, teamId: string) {
  await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.role, "owner")))
    .orderBy(memberships.id)
    .for("update");
}

/** Outcome of a last-owner-guarded write. */
export type GuardedWriteResult =
  | { ok: true }
  | { ok: false; reason: "noop" }
  | { ok: false; reason: "lastOwner" };

/**
 * Set `targetUserId`'s role on `teamId`, guarded so the last owner can't be
 * demoted away from `owner`. The owner-count subquery rides in the WHERE
 * (closes the same-row race), and — when demoting — the team's owner rows are
 * locked FIRST inside a transaction (closes the cross-row write-skew race);
 * see the module doc for both.
 *
 * `.returning()` distinguishes the two zero-row causes the UI must tell apart —
 * row gone → `noop`; row exists but guard blocked (last owner) → `lastOwner` —
 * via a re-check on the zero-row path, inside the same transaction (under the
 * lock) so the disambiguation is itself race-free.
 */
export async function setMemberRole(
  teamId: string,
  targetUserId: string,
  role: MembershipRole,
): Promise<GuardedWriteResult> {
  return db.transaction(async (tx) => {
    // Only demoting away from owner can strand the team, so only it needs the
    // lock; promoting to/keeping owner never reduces the count and is safe to race.
    if (role !== "owner") await lockOwnerRows(tx, teamId);

    const updated = await tx
      .update(memberships)
      .set({ role })
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, targetUserId),
          // Only guard when the new role is NOT owner — promoting/keeping owner
          // never reduces the owner count. When demoting, require not-last-owner.
          role === "owner" ? undefined : notLastOwner(teamId),
        ),
      )
      .returning({ id: memberships.id });

    if (updated.length > 0) return { ok: true };

    // Zero rows: either the row vanished, or the guard blocked a last-owner
    // demotion. Disambiguate with a cheap existence read, still under the lock.
    const stillThere = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, targetUserId),
        ),
      )
      .limit(1);
    if (stillThere.length === 0) return { ok: false, reason: "noop" };
    return { ok: false, reason: "lastOwner" };
  });
}

/**
 * Remove `targetUserId` from `teamId`, guarded so the team's last owner can't
 * be removed. Same owner-count-subquery-in-the-WHERE shape as
 * {@link setMemberRole}, plus the same owner-row lock first (the target might
 * be an owner) — closes both the same-row and cross-row races (module doc).
 * `.returning()` separates "already gone" from "blocked by the guard".
 */
export async function removeMemberGuarded(
  teamId: string,
  targetUserId: string,
): Promise<GuardedWriteResult> {
  return db.transaction(async (tx) => {
    await lockOwnerRows(tx, teamId);

    const deleted = await tx
      .delete(memberships)
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, targetUserId),
          notLastOwner(teamId),
        ),
      )
      .returning({ id: memberships.id });

    if (deleted.length > 0) return { ok: true };

    const stillThere = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, targetUserId),
        ),
      )
      .limit(1);
    if (stillThere.length === 0) return { ok: false, reason: "noop" };
    return { ok: false, reason: "lastOwner" };
  });
}

/** Outcome of the self-leave guarded delete — narrower than {@link GuardedWriteResult}. */
export type LeaveTeamResult = { ok: true } | { ok: false; reason: "lastOwner" };

/**
 * Remove the actor's OWN membership from `teamId`, guarded so the last owner
 * can't leave — same lock + `notLastOwner` shape as {@link removeMemberGuarded},
 * kept here so the guarded-DELETE plumbing has one home and test surface.
 *
 * Narrower result (no `noop`, no re-check): callers only reach this after a
 * member-scope check (`requireRoleScope` → `resolveTeamBySlug` inner-joins
 * `memberships`) has proven the actor's row is live, so a zero-row result can
 * only mean the guard blocked a last-owner leave.
 */
export async function leaveTeamGuarded(
  teamId: string,
  userId: string,
): Promise<LeaveTeamResult> {
  return db.transaction(async (tx) => {
    await lockOwnerRows(tx, teamId);

    const deleted = await tx
      .delete(memberships)
      .where(
        and(
          eq(memberships.teamId, teamId),
          eq(memberships.userId, userId),
          notLastOwner(teamId),
        ),
      )
      .returning({ id: memberships.id });

    return deleted.length > 0
      ? { ok: true }
      : { ok: false, reason: "lastOwner" };
  });
}
