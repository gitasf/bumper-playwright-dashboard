import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { readBodyField } from "@/lib/form";
import { roleSchema, setMemberRole } from "@/lib/members-repo";
import { AuthzError, resolveOwnedTeam } from "@/lib/settings-scope";

/**
 * PATCH /api/teams/:teamSlug/members
 *
 * Owner-only. Changes one member's role and returns the saved role as JSON so
 * the members page can autosave the role `<Select>` (no Save button) without a
 * full-page POST. Replaces the no-JS `updateMemberRole` server action: same
 * shared `setMemberRole` last-owner guard + audit, just a JSON response in
 * place of a redirect.
 *
 * The last-owner invariant rides inside `setMemberRole`'s guarded UPDATE (an
 * owner-count subquery in the WHERE), so demoting the team's sole owner matches
 * 0 rows and surfaces here as `lastOwner` — never a same-row check-then-write
 * race. `setMemberRole` also locks the team's owner rows first (inside a
 * transaction) before a demote's guarded UPDATE runs, closing the cross-row
 * case too — two owners demoting each other concurrently can't both slip past
 * the guard (see the `members-repo` module doc).
 */
export const PATCH = defineHandler(async (c) => {
  const actor = requireAuth(c);
  let team: Awaited<ReturnType<typeof resolveOwnedTeam>>;
  try {
    team = await resolveOwnedTeam(c);
  } catch (err) {
    if (err instanceof AuthzError) return c.json({ error: "Not found" }, 404);
    throw err;
  }

  const userId = await readBodyField(c, {
    jsonKey: "userId",
    formKey: "userId",
  });
  const parsed = roleSchema.safeParse(
    await readBodyField(c, { jsonKey: "role", formKey: "role" }),
  );
  if (!userId || !parsed.success) {
    return c.json({ error: "Pick a valid role for that member." }, 400);
  }

  // No special-casing of self-demotion: an owner demoting themselves is fine as
  // long as another owner remains — exactly what the last-owner guard enforces.
  const result = await setMemberRole(team.id, userId, parsed.data);
  if (!result.ok) {
    if (result.reason === "lastOwner") {
      return c.json(
        {
          error:
            actor.id === userId
              ? "You're the last owner — promote someone else before changing your role."
              : "That's the team's last owner — promote someone else first.",
        },
        409,
      );
    }
    // `noop`: the membership vanished (e.g. removed in another tab).
    return c.json({ error: "That member is no longer on the team." }, 404);
  }

  // Audit only an actual role change (`ok`). A `noop` / last-owner block above
  // returns before this and writes no row.
  await recordAudit(c, {
    teamId: team.id,
    action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGE,
    targetType: "member",
    targetId: userId,
    metadata: { role: parsed.data },
  });

  return c.json({ role: parsed.data });
});
