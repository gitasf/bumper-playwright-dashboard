import type { Context } from "hono";
import type { ResolvedActiveProject } from "@/lib/authz";
import { getActiveProject, requireActiveProject } from "@/lib/active-project";
import { makeTenantScope, type TenantScope } from "@/lib/scope";

/**
 * The two shapes every `/t/:teamSlug/p/:projectSlug/*` loader needs:
 *  - `project`: the rich, auth-checked active project (slug, name, role,
 *    teamName) for rendering.
 *  - `scope`: the same project re-expressed as a `TenantScope` with branded
 *    ids, for use in any `runs / testResults / testTags / testAnnotations /
 *    testResultAttempts / artifacts` query.
 *
 * Both are derived from `c.var.activeProject`, populated once per request by
 * `middleware/01.context.ts` (one indexed `memberships ⋈ teams ⟕ projects`
 * join). Loaders previously re-ran that join inline — see git history for
 * the migration.
 */
export interface TenantContext {
  project: ResolvedActiveProject;
  scope: TenantScope;
}

function toScope(project: ResolvedActiveProject): TenantScope {
  return makeTenantScope({
    teamId: project.teamId,
    projectId: project.id,
    teamSlug: project.teamSlug,
    projectSlug: project.slug,
  });
}

export function getTenantContext(c: Context): TenantContext | null {
  const project = getActiveProject(c);
  if (!project) return null;
  return { project, scope: toScope(project) };
}

/**
 * 404 if the request didn't carry a `/t/:teamSlug/p/:projectSlug` pair the
 * user has membership in. The middleware regex (`TENANT_PATH_RE` in
 * `middleware/01.context.ts`) gates exactly the URLs that produce a populated
 * `activeProject`, so reaching a loader without one is a routing bug — same
 * 404 the old inline `resolveProjectBySlugs(...) → null` path produced.
 */
export function requireTenantContext(c: Context): TenantContext {
  const project = requireActiveProject(c);
  return { project, scope: toScope(project) };
}

/**
 * Owner-gated sibling of {@link requireTenantContext}, for MUTATING a project
 * resource (monitors create/edit/delete/pause). Reading stays member-level via
 * `requireTenantContext`; this adds the owner check so the same capability bar
 * the owner-only API-key page enforces (`requireOwnedProjectScope`) also covers
 * monitors — which transitively mint a per-run ingest key and run user-authored
 * code server-side, a strictly greater capability than minting a key directly.
 *
 * 404 (not 403) on a non-owner, mirroring the settings owner seam: it denies
 * without confirming the action and routes to the styled not-found page via the
 * error middleware (a bare 403 body would not). A non-owner only reaches this
 * via a crafted POST — the UI hides the controls — so the leak-shaped 404 is the
 * consistent choice even though a member can already view the resource.
 */
export function requireOwnerTenantContext(c: Context): TenantContext {
  const ctx = requireTenantContext(c);
  if (ctx.project.role !== "owner") {
    throw new Response("Not Found", { status: 404 });
  }
  return ctx;
}
