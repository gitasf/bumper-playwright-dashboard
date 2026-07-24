import { db, and, eq, gt, sql } from "void/db";
import {
  memberships,
  projects,
  runs,
  teamInvites,
  teams,
  type MembershipRole,
} from "@schema";
import {
  buildInviteMatchConds,
  getUserIdentity,
  inviteMatchedBy,
} from "@/lib/auth-users";

export type TeamRole = MembershipRole;

/**
 * A team/project entry in the workspace-switcher lists (`userTeams` /
 * `teamProjects`). The minimal `{ slug, name }` shape used to be spelled
 * inline in every producer and consumer; this is the single source of truth.
 */
export interface WorkspaceListItem {
  slug: string;
  name: string;
}

/**
 * Resolve a team by slug + verify membership in one round-trip. Returns null
 * when the team doesn't exist OR the user isn't a member — callers should
 * 404 in both cases (don't leak team existence).
 */
export async function resolveTeamBySlug(
  userId: string,
  teamSlug: string,
): Promise<{
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
} | null> {
  const rows = await db
    .select({
      id: teams.id,
      slug: teams.slug,
      name: teams.name,
      role: memberships.role,
    })
    .from(teams)
    .innerJoin(
      memberships,
      and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
    )
    .where(eq(teams.slug, teamSlug))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row;
}

export async function getUserTeams(
  userId: string,
): Promise<WorkspaceListItem[]> {
  return db
    .select({ slug: teams.slug, name: teams.name })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, userId));
}

export interface PendingInvite {
  id: string;
  teamId: string;
  teamSlug: string;
  teamName: string;
  role: TeamRole;
  expiresAt: number;
  matchedBy: "email" | "githubLogin";
}

/**
 * Invites addressed directly to this user's VERIFIED `user.email` (from
 * void-managed auth tables). Used by the team picker to surface "you've been
 * invited" cards on first login. GitHub-login-directed invites are NOT
 * surfaced here — this is a tokenless path and the login is mutable/reusable
 * (see `buildInviteMatchConds`); those are redeemed via the secret
 * `/invite/:token` share-link instead.
 *
 * Resolves the user's identity through the `auth-users` seam (which owns the
 * raw `"user"` read + email lowercasing).
 */
export async function getPendingInvitesForUser(
  userId: string,
): Promise<PendingInvite[]> {
  const identity = await getUserIdentity(userId);
  const matchConds = buildInviteMatchConds(identity);
  if (!matchConds) return [];

  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: teamInvites.id,
      teamId: teamInvites.teamId,
      role: teamInvites.role,
      email: teamInvites.email,
      githubLogin: teamInvites.githubLogin,
      expiresAt: teamInvites.expiresAt,
      teamSlug: teams.slug,
      teamName: teams.name,
    })
    .from(teamInvites)
    .innerJoin(teams, eq(teams.id, teamInvites.teamId))
    .where(and(matchConds, gt(teamInvites.expiresAt, now)))
    .orderBy(sql`${teamInvites.createdAt} desc`);

  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    teamSlug: r.teamSlug,
    teamName: r.teamName,
    role: r.role,
    expiresAt: r.expiresAt,
    matchedBy: inviteMatchedBy(identity, r.email),
  }));
}

export interface ResolvedActiveTeam {
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
}

export interface ResolvedActiveProject {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  teamName: string;
  role: TeamRole;
}

export interface TenantBundle {
  userTeams: WorkspaceListItem[];
  activeTeam: ResolvedActiveTeam | null;
  teamProjects: WorkspaceListItem[];
  activeProject: ResolvedActiveProject | null;
  /**
   * Every team the user belongs to, each with their role — not just `teamSlug`.
   * Free: the query has no team filter (`.where(eq(memberships.userId, userId))`),
   * so this just retains rows the `activeTeam` reduction used to discard. Lets
   * request-scoped callers answer "does this user have role X on team Y" for a
   * team OTHER than the selected one (e.g. `settings-scope.ts`, where the URL
   * team can differ from the cookie-selected workspace) without re-querying.
   * Server-only — NOT part of `SharedBundle`, same separation as `activeProject`.
   */
  memberTeams: ResolvedActiveTeam[];
}

/**
 * Resolve every piece of team/project data the dashboard needs for a
 * `/t/:teamSlug[/p/:projectSlug]/...` request in a single SQL query.
 *
 * Same approach as the rwsdk version: one `memberships ⋈ teams ⟕ projects`
 * join filtered by `userId`, then derive each output bucket in JS from the
 * row set. `activeTeam` is null when the user isn't a member of `teamSlug`;
 * `activeProject` is null when the project doesn't exist within an authorized
 * team. Callers (middleware) should not 404 here — pages can render a
 * team/project picker for the no-active-team case.
 */
export async function resolveTenantBundleForUser(
  userId: string,
  teamSlug: string | null,
  projectSlug: string | null,
): Promise<TenantBundle> {
  const rows = await db
    .select({
      teamId: teams.id,
      teamSlug: teams.slug,
      teamName: teams.name,
      role: memberships.role,
      projectId: projects.id,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .leftJoin(projects, eq(projects.teamId, teams.id))
    .where(eq(memberships.userId, userId));

  const userTeamsBySlug = new Map<string, WorkspaceListItem>();
  const memberTeamsBySlug = new Map<string, ResolvedActiveTeam>();
  let activeProject: ResolvedActiveProject | null = null;
  const teamProjectsBySlug = new Map<string, WorkspaceListItem>();

  for (const r of rows) {
    if (!userTeamsBySlug.has(r.teamSlug)) {
      userTeamsBySlug.set(r.teamSlug, { slug: r.teamSlug, name: r.teamName });
    }
    // Capture the role for every team, not just the active one (see the
    // `memberTeams` field doc) — free, no team filter on the query.
    if (!memberTeamsBySlug.has(r.teamSlug)) {
      memberTeamsBySlug.set(r.teamSlug, {
        id: r.teamId,
        slug: r.teamSlug,
        name: r.teamName,
        role: r.role,
      });
    }
    if (teamSlug && r.teamSlug === teamSlug) {
      if (
        r.projectSlug &&
        r.projectName &&
        !teamProjectsBySlug.has(r.projectSlug)
      ) {
        teamProjectsBySlug.set(r.projectSlug, {
          slug: r.projectSlug,
          name: r.projectName,
        });
      }
      if (
        projectSlug &&
        r.projectSlug === projectSlug &&
        r.projectId &&
        r.projectName &&
        !activeProject
      ) {
        activeProject = {
          id: r.projectId,
          teamId: r.teamId,
          slug: r.projectSlug,
          name: r.projectName,
          teamSlug: r.teamSlug,
          teamName: r.teamName,
          role: r.role,
        };
      }
    }
  }

  const activeTeam = teamSlug
    ? (memberTeamsBySlug.get(teamSlug) ?? null)
    : null;

  return {
    userTeams: [...userTeamsBySlug.values()],
    activeTeam,
    teamProjects: [...teamProjectsBySlug.values()],
    activeProject,
    memberTeams: [...memberTeamsBySlug.values()],
  };
}

/**
 * The membership-checked project row `resolveProjectBySlugs` returns — the
 * project's identity plus the caller's `role` within its team, for
 * capability gates (`can(role, …)`).
 */
export interface UserProjectMembership {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  role: TeamRole;
}

export async function resolveProjectBySlugs(
  userId: string,
  teamSlug: string,
  projectSlug: string,
): Promise<UserProjectMembership | null> {
  const rows = await db
    .select({
      id: projects.id,
      teamId: projects.teamId,
      slug: projects.slug,
      name: projects.name,
      teamSlug: teams.slug,
      role: memberships.role,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(
      memberships,
      and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
    )
    .where(and(eq(teams.slug, teamSlug), eq(projects.slug, projectSlug)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row;
}

// ---------- Realtime subscription authorization ----------

/**
 * The DB-bound half of the realtime isolation gate: does `userId` belong to
 * the team that owns run `runId`? One indexed `runs ⋈ memberships` join — the
 * realtime analogue of the `AuthorizedProjectId` scope predicate (a logged-in
 * member of team A must not be able to subscribe to team B's run stream).
 *
 * Injected into {@link authorizeTopicSubscription} as `RunMembershipLookup`
 * so the pure authorization DECISION (topic parse + null-user / empty-rows
 * rejection) can be unit-tested with a fake lookup — no room connect and no
 * real D1 required.
 */
export type RunMembershipLookup = (
  runId: string,
  userId: string,
) => Promise<boolean>;

const lookupRunMembership: RunMembershipLookup = async (runId, userId) => {
  const rows = await db
    .select({ teamId: runs.teamId })
    .from(runs)
    .innerJoin(
      memberships,
      and(eq(memberships.teamId, runs.teamId), eq(memberships.userId, userId)),
    )
    .where(eq(runs.id, runId))
    .limit(1);
  return rows.length > 0;
};

/**
 * The DB-bound half of the PROJECT topic gate: does `userId` belong to the team
 * that owns `projectId`? One indexed `projects ⋈ memberships` join. The runs
 * list subscribes to `project:<projectId>` for live `run-created` /
 * `run-progress` events, so a member of team A must not subscribe to team B's
 * project feed.
 */
export type ProjectMembershipLookup = (
  projectId: string,
  userId: string,
) => Promise<boolean>;

const lookupProjectMembership: ProjectMembershipLookup = async (
  projectId,
  userId,
) => {
  const rows = await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .innerJoin(
      memberships,
      and(
        eq(memberships.teamId, projects.teamId),
        eq(memberships.userId, userId),
      ),
    )
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows.length > 0;
};

/** Topics the realtime rooms know how to authorize. */
const RUN_TOPIC_RE = /^run:([^:]+)$/;
const PROJECT_TOPIC_RE = /^project:([^:]+)$/;

/**
 * Decide whether a connection may subscribe to a `void/ws` room topic. This is
 * the single tenant-isolation gate for realtime — the one isolation check that
 * does NOT route through `scope.ts` / a branded id, because the room connect
 * hands us a raw topic string.
 *
 * Owns the whole decision so it is unit-testable in isolation:
 *   - `userId === null` → 403 (anonymous connection; no lookup runs);
 *   - the topic must match `run:<runId>` or `project:<projectId>` exactly —
 *     `run:`, `run:a:b`, `project:`, and any other topic are rejected 403 (no
 *     lookup runs);
 *   - a well-formed topic is allowed only when the matching injected lookup
 *     confirms membership (run → owning team; project → owning team); an empty
 *     result is the cross-team denial → 403.
 *
 * The `runLookup` / `projectLookup` parameters default to the real
 * `… ⋈ memberships` joins; tests pass fakes to exercise every branch without
 * touching D1.
 */
export async function authorizeTopicSubscription(
  userId: string | null,
  topic: string,
  runLookup: RunMembershipLookup = lookupRunMembership,
  projectLookup: ProjectMembershipLookup = lookupProjectMembership,
): Promise<{ ok: true } | { ok: false; status: 403 }> {
  if (!userId) return { ok: false, status: 403 };
  const runMatch = RUN_TOPIC_RE.exec(topic);
  if (runMatch) {
    const isMember = await runLookup(runMatch[1], userId);
    return isMember ? { ok: true } : { ok: false, status: 403 };
  }
  const projectMatch = PROJECT_TOPIC_RE.exec(topic);
  if (projectMatch) {
    const isMember = await projectLookup(projectMatch[1], userId);
    return isMember ? { ok: true } : { ok: false, status: 403 };
  }
  return { ok: false, status: 403 };
}
