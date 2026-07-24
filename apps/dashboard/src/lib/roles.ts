import type { MembershipRole } from "@schema";

/**
 * Granular RBAC capability model (roadmap 3.1).
 *
 * `MembershipRole` is the stored, coarse identity (`owner | member | viewer`);
 * `Capability` is the fine-grained THING a role may do. `can(role, action)` is
 * the single source of truth that maps the former onto the latter, so every
 * gate in the app (the settings seams, the API handlers, the UI flags) asks the
 * same question instead of re-deriving `role === "owner"` inline. Keep it pure
 * (no I/O, no `Context`) so the whole matrix is exhaustively unit-testable.
 *
 * The capabilities, deliberately framed as VERBS over team resources:
 *  - `viewSettings`  — read the team/project settings pages (the privileged
 *                      surface: members + invites, keys list, retention, etc.).
 *  - `manageMembers` — change a member's role, remove a member, mint/revoke
 *                      invites (and pick the invited role).
 *  - `mintKeys`      — create/revoke project API keys, and the strictly-greater
 *                      monitor capability that transitively mints per-run keys.
 *  - `writeConfig`   — mutate team/project config (rename, slug, retention,
 *                      create projects, quarantine, test-ownership edits).
 *  - `deleteTeam`    — the irreversible team delete.
 */
export type Capability =
  | "viewSettings"
  | "manageMembers"
  | "mintKeys"
  | "writeConfig"
  | "deleteTeam";

/**
 * What an authz gate (`requireRoleScope` / `resolveProjectApiScope`) accepts in
 * place of a `Capability`. `"anyMember"` is the explicit bare-membership bar
 * (any membership, viewer included, passes) — it exists so gates require a
 * stated bar at every call site rather than a permissive default on omission,
 * so a mutation route can't inherit the most-permissive behaviour by leaving
 * the argument out.
 */
export type CapabilityGate = Capability | "anyMember";

/**
 * The capability matrix. Defined explicitly (a full row per role) rather than
 * derived from a hierarchy so the grant set for every role reads off the page
 * and a future role can't silently inherit a capability.
 *
 * WHY member === viewSettings only (and NOT writeConfig / mintKeys):
 *   The pre-3.1 codebase has exactly two roles. Every *mutation* — key minting
 *   (`requireOwnedProjectScope`), config writes (`requireOwnerScope`), project
 *   creation, monitors, quarantine, member management, team delete — is already
 *   OWNER-gated; a plain `member` could only *read* the settings pages (the
 *   bare-membership gate, today `requireRoleScope(c, "anyMember")`). So
 *   preserving TODAY's member capabilities (the hard
 *   constraint — don't downgrade existing members, and don't silently UPGRADE
 *   them either) means `member` maps to `viewSettings` and nothing more. If
 *   members were ever to gain write/mint rights it would be an intentional,
 *   reviewable change to this one table — not a side effect of adding viewer.
 *
 * WHY viewer === no capabilities:
 *   A viewer is a member for READ paths (run/test data, realtime) — the
 *   distinction is purely the absence of these privileged settings caps. It is
 *   NOT granted `viewSettings`: settings (members, keys, invites, retention) is
 *   a privileged surface, so a viewer reads the dashboard but 404s on the
 *   settings pages, exactly as the plan's manual check describes.
 */
const CAPABILITIES: Record<MembershipRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([
    "viewSettings",
    "manageMembers",
    "mintKeys",
    "writeConfig",
    "deleteTeam",
  ]),
  member: new Set<Capability>(["viewSettings"]),
  viewer: new Set<Capability>(),
};

/**
 * Does `role` grant `action`? The one capability question the whole app asks.
 * Pure and total over `MembershipRole × Capability`.
 */
export function can(role: MembershipRole, action: Capability): boolean {
  return CAPABILITIES[role].has(action);
}

/**
 * The roles a `manageMembers`-holder may ASSIGN (to a member, or mint an invite
 * for). Re-exported so the Zod validators on `updateMemberRole` / invite-mint
 * and the UI selectors share one list and can't drift. Order is the UI order
 * (most-privileged first). `as const` makes it the non-empty tuple `z.enum`
 * wants directly (no cast); the `satisfies` line statically guarantees it
 * stays exactly the `MembershipRole` union — drop or mistype a role and the
 * compiler complains here.
 */
export const ASSIGNABLE_ROLES = ["owner", "member", "viewer"] as const;

// Compile-time guard that the list stays in lockstep with the role union in
// BOTH directions: every listed value is a MembershipRole, and every
// MembershipRole is listed. A missing/extra/mistyped role fails to compile.
type _ListIsAllRoles = (typeof ASSIGNABLE_ROLES)[number] extends MembershipRole
  ? MembershipRole extends (typeof ASSIGNABLE_ROLES)[number]
    ? true
    : never
  : never;
const _assignableRolesAreExhaustive: _ListIsAllRoles = true;
void _assignableRolesAreExhaustive;

/** Human-readable one-liner per role for the role-selector UI. */
export const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  owner: "Full access — manage members, keys, settings, and delete the team.",
  member: "Read everything and view settings; can't change members or keys.",
  viewer: "Read-only access to runs and reports; no settings access.",
};
