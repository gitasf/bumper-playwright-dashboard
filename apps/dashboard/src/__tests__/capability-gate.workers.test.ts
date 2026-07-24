import { describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { TeamRole } from "@/lib/authz";

/**
 * `requireRoleScope` (`@/lib/settings-scope`) and `resolveProjectApiScope`
 * (`@/lib/tenant-api-scope`) used to take an OPTIONAL `Capability`, where
 * omitting it silently meant "most permissive" (bare membership — any role,
 * viewer included). That is a footgun on an auth seam: a new mutation route
 * that copies a read call site's arguments compiles clean and grants viewers
 * write access. Both now take a REQUIRED `CapabilityGate`
 * (`Capability | "anyMember"`, `@/lib/roles`) — the bare-membership bar must
 * be stated explicitly as `"anyMember"`.
 *
 * This guards the migration through a real `Hono` app (so `c.req.param` /
 * `c.json` behave exactly as they do in production, matching the
 * `mcp-auth.workers.test.ts` convention) rather than a hand-rolled fake
 * context: `"anyMember"` must still admit a viewer (the intended
 * bare-membership behaviour, now spelled explicitly instead of defaulted),
 * and a real capability must still 404 an insufficient role exactly as it
 * did when the parameter was optional. `void/auth` and the DB-bound
 * membership resolves (`@/lib/authz`, `@/lib/scope`) are faked so this stays
 * a pure unit test of the two seams' branching, no live Postgres required.
 */

vi.mock("void/auth", () => ({
  requireAuth: () => ({ id: "user_1" }),
}));

let teamRow: {
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
} | null = null;
vi.mock("@/lib/authz", () => ({
  resolveTeamBySlug: async () => teamRow,
  resolveProjectBySlugs: async () => null,
}));

let projectRow: {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  role: TeamRole;
} | null = null;
vi.mock("@/lib/scope", () => ({
  tenantContextForUserBySlugs: async () =>
    projectRow ? { project: projectRow, scope: {} } : null,
  tenantScopeForUserBySlugs: async () => null,
  makeTenantScope: (parts: unknown) => parts,
}));

const { requireRoleScope } = await import("@/lib/settings-scope");
const { resolveProjectApiScope } = await import("@/lib/tenant-api-scope");

const ORIGIN = "https://wrightful.test";

function team(role: TeamRole) {
  return { id: "team_1", slug: "acme", name: "Acme", role };
}

function project(role: TeamRole) {
  return {
    id: "proj_1",
    teamId: "team_1",
    slug: "web",
    name: "Web",
    teamSlug: "acme",
    role,
  };
}

describe("requireRoleScope (CapabilityGate — required, no permissive default)", () => {
  const app = new Hono();
  app.get("/any/:teamSlug", async (c) => {
    try {
      const { team } = await requireRoleScope(c, "anyMember");
      return c.json({ role: team.role });
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
  });
  app.get("/manage/:teamSlug", async (c) => {
    try {
      const { team } = await requireRoleScope(c, "manageMembers");
      return c.json({ role: team.role });
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
  });

  it('"anyMember" admits a viewer (the bare-membership bar, now stated explicitly)', async () => {
    teamRow = team("viewer");
    const res = await app.request(`${ORIGIN}/any/acme`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "viewer" });
  });

  it("a stated capability still 404s an insufficient role", async () => {
    teamRow = team("viewer");
    const res = await app.request(`${ORIGIN}/manage/acme`);
    expect(res.status).toBe(404);
  });

  it("a stated capability still admits a sufficient role", async () => {
    teamRow = team("owner");
    const res = await app.request(`${ORIGIN}/manage/acme`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "owner" });
  });
});

describe("resolveProjectApiScope (CapabilityGate — required, no permissive default)", () => {
  const app = new Hono();
  app.get("/proj/any/:teamSlug/:projectSlug", async (c) => {
    const ctx = await resolveProjectApiScope(c, "anyMember");
    if (ctx instanceof Response) return ctx;
    return c.json({ role: ctx.project.role });
  });
  app.get("/proj/write/:teamSlug/:projectSlug", async (c) => {
    const ctx = await resolveProjectApiScope(c, "writeConfig");
    if (ctx instanceof Response) return ctx;
    return c.json({ role: ctx.project.role });
  });

  it('"anyMember" admits a viewer (the bare-membership bar, now stated explicitly)', async () => {
    projectRow = project("viewer");
    const res = await app.request(`${ORIGIN}/proj/any/acme/web`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "viewer" });
  });

  it("a stated capability still 404s an insufficient role", async () => {
    projectRow = project("viewer");
    const res = await app.request(`${ORIGIN}/proj/write/acme/web`);
    expect(res.status).toBe(404);
  });

  it("a stated capability still admits a sufficient role", async () => {
    projectRow = project("owner");
    const res = await app.request(`${ORIGIN}/proj/write/acme/web`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "owner" });
  });
});
