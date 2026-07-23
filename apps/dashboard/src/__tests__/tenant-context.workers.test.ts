import { describe, it, expect } from "vite-plus/test";
import type { Context } from "hono";
import type { ResolvedActiveProject } from "@/lib/authz";
import type { MembershipRole } from "@schema";
import {
  requireOwnerTenantContext,
  requireTenantContext,
} from "@/lib/tenant-context";

function makeCtx(activeProject: ResolvedActiveProject | null | undefined): {
  ctx: Context;
} {
  const store = new Map<string, unknown>();
  if (activeProject !== undefined) store.set("activeProject", activeProject);
  return {
    ctx: {
      get: (key: string) => store.get(key),
    } as unknown as Context,
  };
}

function projectWithRole(role: MembershipRole): ResolvedActiveProject {
  return {
    id: "proj-1",
    teamId: "team-1",
    slug: "web",
    name: "Web",
    teamSlug: "acme",
    teamName: "Acme",
    role,
  };
}

function expect404(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected a thrown Response");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
  }
}

describe("requireTenantContext", () => {
  it("returns the active project and a branded scope mirroring its ids", () => {
    const { ctx } = makeCtx(projectWithRole("owner"));
    const { project, scope } = requireTenantContext(ctx);

    expect(project.id).toBe("proj-1");
    expect(project.role).toBe("owner");

    expect(scope.projectId).toBe(project.id);
    expect(scope.teamId).toBe(project.teamId);
    expect(scope.teamSlug).toBe(project.teamSlug);
    expect(scope.projectSlug).toBe(project.slug);
  });

  it("resolves the scope for a viewer just as it does for an owner (reads are member-level)", () => {
    const { ctx } = makeCtx(projectWithRole("viewer"));
    const { scope } = requireTenantContext(ctx);
    expect(scope.projectId).toBe("proj-1");
  });

  it("throws a 404 Response when no active project was resolved (no membership)", () => {
    expect404(() => requireTenantContext(makeCtx(undefined).ctx));
  });

  it("throws a 404 Response when active project is explicitly null", () => {
    expect404(() => requireTenantContext(makeCtx(null).ctx));
  });
});

describe("requireOwnerTenantContext", () => {
  it("returns the context for an owner (holds mintKeys)", () => {
    const { ctx } = makeCtx(projectWithRole("owner"));
    const { project, scope } = requireOwnerTenantContext(ctx);
    expect(project.role).toBe("owner");
    expect(scope.projectId).toBe("proj-1");
  });

  it("denies a member with 404 (not 403) — leak-safe posture, no capability", () => {
    expect404(() =>
      requireOwnerTenantContext(makeCtx(projectWithRole("member")).ctx),
    );
  });

  it("denies a viewer with 404 (not 403)", () => {
    expect404(() =>
      requireOwnerTenantContext(makeCtx(projectWithRole("viewer")).ctx),
    );
  });

  it("throws 404 when no active project was resolved (delegates to requireTenantContext)", () => {
    expect404(() => requireOwnerTenantContext(makeCtx(undefined).ctx));
  });
});
