import { db, eq, like, or } from "void/db";
import { env } from "void/env";
import { ulid } from "ulid";
import { memberships, projects, teams as teamsTable } from "@schema";
import { openSignupAllowed } from "@/lib/config";
import { runBatch } from "@/lib/db-batch";
import { SLUG_MAX_LEN } from "@/lib/slug";

/**
 * Canonical team/project provisioning seam.
 *
 * The slug-derivation + insert logic used to be inlined and duplicated
 * verbatim across the two create-form actions (`pages/settings/teams/new`,
 * `.../projects/new`) — and was reachable from out-of-process callers (the
 * local seeder, the e2e dashboard fixture) only by POSTing to the human form
 * action and inferring success/failure by regex-matching the 302 `Location`
 * header. That coupled the bootstrap scripts to UI route shapes.
 *
 * This module concentrates the canonical create path so BOTH the form actions
 * AND the owner-auth'd JSON routes (`POST /api/teams`,
 * `POST /api/teams/:teamSlug/projects`) call the same code, and the scripts can
 * consume a stable typed JSON contract instead of scraping redirects.
 *
 * Split deliberately: the slug functions are PURE (unit-tested in isolation,
 * no D1); the `create*` functions compose them with the collision query + the
 * atomic insert. The pure half is the testable surface; the DB half is thin
 * orchestration over Drizzle.
 */

// Re-exported for existing consumers; the canonical definition lives next to
// SLUG_RE in `@/lib/slug` so the regex and the cap can't drift.
export { SLUG_MAX_LEN } from "@/lib/slug";

/**
 * Failure to derive even a base slug from a name. Status-agnostic on purpose:
 * the form action redirects with `?error=`, the JSON route returns 400.
 */
export class SlugDerivationError extends Error {
  constructor(message = "Name must contain at least one letter or number.") {
    super(message);
    this.name = "SlugDerivationError";
  }
}

/**
 * Derive a URL-safe base slug from a display name: lowercase, collapse runs of
 * non-alphanumerics to single hyphens, trim leading/trailing hyphens, cap at
 * {@link SLUG_MAX_LEN}. Returns `null` when nothing usable remains (e.g. a name
 * of only punctuation/whitespace).
 */
export function slugifyName(name: string): string | null {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/, "");
  return base.length >= 1 ? base : null;
}

/**
 * Given a base slug and the set of already-taken slugs, return the first free
 * slug: the base itself if available, else `base-2`, `base-3`, … (each
 * re-trimmed to stay within {@link SLUG_MAX_LEN}). Falls back to a random
 * 6-char suffix after 999 collisions — astronomically unlikely, and the insert
 * still rejects on a true collision so the caller surfaces a retry error.
 */
export function pickUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 999; i++) {
    const suffix = `-${i}`;
    const trimmed = base
      .slice(0, SLUG_MAX_LEN - suffix.length)
      .replace(/-+$/, "");
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, SLUG_MAX_LEN - 7).replace(/-+$/, "")}-${ulid().slice(-6).toLowerCase()}`;
}

/**
 * Resolve a fresh, collision-free team slug for `name`. Throws
 * {@link SlugDerivationError} when `name` has no usable slug. Pure-ish: the
 * only side effect is the read-only collision query.
 */
async function resolveTeamSlug(name: string): Promise<string> {
  const baseSlug = slugifyName(name);
  if (!baseSlug) throw new SlugDerivationError();
  const existing = await db
    .select({ slug: teamsTable.slug })
    .from(teamsTable)
    .where(
      or(eq(teamsTable.slug, baseSlug), like(teamsTable.slug, `${baseSlug}-%`)),
    );
  return pickUniqueSlug(baseSlug, new Set(existing.map((r) => r.slug)));
}

/**
 * Team creation refused by the instance policy (see {@link teamCreationAllowed}).
 * Status-agnostic like {@link SlugDerivationError}: the form action redirects
 * with `?error=`, the JSON route returns 403.
 */
export class TeamCreationNotAllowedError extends Error {
  constructor(
    message = "Team creation on this instance is invite-only. Ask a team owner for an invite.",
  ) {
    super(message);
    this.name = "TeamCreationNotAllowedError";
  }
}

/**
 * Whether a user may create a team on this instance. PURE — the policy
 * decision over pre-resolved inputs; `createTeamForUser` resolves them.
 *
 * Open-signup instances allow anyone. On a closed (invite-only) instance the
 * gate is the actual abuse boundary: GitHub OAuth signup must stay open there
 * (it is the only way an invited newcomer can create an account — invites
 * don't mint users), so "closed" is enforced one step later, at the first
 * resource-granting action. A self-registered stranger holds a dead account:
 * no team, no projects, no API keys, no synthetic monitors (which execute
 * arbitrary Playwright code in containers on the operator's Cloudflare
 * account). Existing members may always create more teams, and the zero-teams
 * case lets the operator bootstrap a fresh instance.
 */
export function teamCreationAllowed(input: {
  openSignup: boolean;
  isMemberOfAnyTeam: boolean;
  anyTeamExists: boolean;
}): boolean {
  return input.openSignup || input.isMemberOfAnyTeam || !input.anyTeamExists;
}

/**
 * Create a team + owner membership for `userId` atomically (one D1 batch) and
 * return the assigned slug. The single canonical create-team path shared by
 * the form action and `POST /api/teams`. Throws {@link SlugDerivationError}
 * for an unusable name and {@link TeamCreationNotAllowedError} when the
 * instance policy refuses (closed instance, memberless user — see
 * {@link teamCreationAllowed}); lets DB errors (e.g. a unique violation from a
 * slug race) propagate so each caller maps them to its own friendly message.
 */
export async function createTeamForUser(
  userId: string,
  name: string,
): Promise<{ slug: string }> {
  const [membershipRows, teamRows] = await Promise.all([
    db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1),
    db.select({ id: teamsTable.id }).from(teamsTable).limit(1),
  ]);
  const allowed = teamCreationAllowed({
    openSignup: openSignupAllowed(env.ALLOW_OPEN_SIGNUP),
    isMemberOfAnyTeam: Boolean(membershipRows[0]),
    anyTeamExists: Boolean(teamRows[0]),
  });
  if (!allowed) throw new TeamCreationNotAllowedError();

  const slug = await resolveTeamSlug(name);
  const teamId = ulid();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await runBatch((tx) => [
    tx.insert(teamsTable).values({
      id: teamId,
      slug,
      name,
      createdAt: nowSeconds,
      lastActivityAt: null,
    }),
    tx.insert(memberships).values({
      id: ulid(),
      userId,
      teamId,
      role: "owner",
      createdAt: nowSeconds,
    }),
  ]);
  return { slug };
}

/**
 * Resolve a fresh, collision-free project slug for `name` within `teamId`
 * (uniqueness is `(teamId, slug)`). Throws {@link SlugDerivationError} when
 * `name` has no usable slug.
 */
async function resolveProjectSlug(
  teamId: string,
  name: string,
): Promise<string> {
  const baseSlug = slugifyName(name);
  if (!baseSlug) throw new SlugDerivationError();
  const existing = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, teamId));
  return pickUniqueSlug(baseSlug, new Set(existing.map((r) => r.slug)));
}

/**
 * Create a project within `teamId` and return its assigned slug. The single
 * canonical create-project path shared by the form action and
 * `POST /api/teams/:teamSlug/projects`. Throws {@link SlugDerivationError} for
 * an unusable name; lets DB errors propagate.
 */
export async function createProjectForTeam(
  teamId: string,
  name: string,
): Promise<{ slug: string }> {
  const slug = await resolveProjectSlug(teamId, name);
  await db.insert(projects).values({
    id: ulid(),
    teamId,
    slug,
    name,
    createdAt: Math.floor(Date.now() / 1000),
  });
  return { slug };
}
