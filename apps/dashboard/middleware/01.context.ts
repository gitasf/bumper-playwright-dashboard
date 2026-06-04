import { defineMiddleware } from "void";
import { getSession } from "void/auth";
import { resolveTenantBundleForUser } from "@/lib/authz";
import type { ResolvedActiveProject, SharedBundle } from "@/lib/shared-bundle";
import {
  clearWorkspaceCookie,
  readWorkspaceCookie,
  setWorkspaceCookie,
} from "@/lib/workspace-cookie";

/**
 * Resolves the per-request tenant bundle (selected team + project + sibling
 * lists) once and publishes it as both `c.var.activeProject` (for server-side
 * loaders that need an auth-checked, URL-bound project) and `c.var.shared`
 * (consumed by `useShared()` in the route-level layouts).
 *
 * Selection model: the user's "selected workspace" lives in the `wf_workspace`
 * cookie. The URL overrides the cookie when it pins a team/project, and the
 * cookie is rewritten so subsequent non-tenant requests (e.g. /settings) keep
 * showing the right workspace. No DB read/write on the hot path — selection
 * is stateless from the server's POV; membership filtering inside
 * `resolveTenantBundleForUser` is the only guard.
 *
 * `c.var.activeProject` (branded `AuthorizedProjectId`) stays URL-bound — only
 * set when the URL pins a project the user belongs to. Loaders authorizing
 * tenant writes continue reading from this channel via `getActiveProject(c)`.
 */
const TENANT_PATH_RE = /^\/t\/([^/]+)(?:\/p\/([^/]+))?(?:\/|$)/;
const API_PATH_RE = /^\/api(?:\/|$)/;

declare module "void" {
  interface CloudContextVariables {
    /** Server-side handle to the active project; read via `getActiveProject(c)`. */
    activeProject?: ResolvedActiveProject | null;
    /** Read on the client via `useShared()`. */
    shared: SharedBundle;
  }
}

const STUB_SHARED = (auth: SharedBundle["auth"]): SharedBundle => ({
  auth,
  userTeams: [],
  selectedTeam: null,
  teamProjects: [],
  selectedProject: null,
});

export default defineMiddleware(async (c, next) => {
  const session = getSession();
  const auth: SharedBundle["auth"] = session
    ? {
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image ?? null,
        },
      }
    : null;

  const url = new URL(c.req.url);

  if (!session) {
    // Anonymous visitors to a protected tenant/settings page are sent to
    // /login (consistent with the "/" picker) rather than falling through to
    // the loader's 404 — a missing session is an auth prompt, not a missing
    // resource. Public paths (/, /login, /signup, /invite, /api/*, assets)
    // fall through to render anonymously.
    const p = url.pathname;
    if (TENANT_PATH_RE.test(p) || p.startsWith("/settings")) {
      return c.redirect("/login");
    }
    c.set("shared", STUB_SHARED(auth));
    await next();
    return;
  }

  if (API_PATH_RE.test(url.pathname)) {
    c.set("shared", STUB_SHARED(auth));
    await next();
    return;
  }

  const urlMatch = url.pathname.match(TENANT_PATH_RE);
  const urlTeamSlug = urlMatch?.[1] ?? null;
  const urlProjectSlug = urlMatch?.[2] ?? null;

  const cookie = readWorkspaceCookie(c);
  const effectiveTeamSlug = urlTeamSlug ?? cookie.teamSlug;
  const effectiveProjectSlug =
    urlProjectSlug ??
    (cookie.teamSlug === effectiveTeamSlug ? cookie.projectSlug : null);

  const bundle = await resolveTenantBundleForUser(
    session.user.id,
    effectiveTeamSlug,
    effectiveProjectSlug,
  );

  c.set("shared", {
    auth,
    userTeams: bundle.userTeams,
    selectedTeam: bundle.activeTeam,
    teamProjects: bundle.teamProjects,
    selectedProject: bundle.activeProject,
  });

  if (urlTeamSlug) {
    c.set("activeProject", bundle.activeProject);

    const resolvedTeamSlug = bundle.activeTeam?.slug ?? null;
    const resolvedProjectSlug = bundle.activeProject?.slug ?? null;
    const current =
      cookie.teamSlug != null
        ? `${cookie.teamSlug}:${cookie.projectSlug ?? ""}`
        : null;

    if (resolvedTeamSlug === null) {
      if (current !== null) clearWorkspaceCookie(c);
    } else {
      const desired = `${resolvedTeamSlug}:${resolvedProjectSlug ?? ""}`;
      if (desired !== current) {
        setWorkspaceCookie(c, resolvedTeamSlug, resolvedProjectSlug);
      }
    }
  }

  await next();
});
