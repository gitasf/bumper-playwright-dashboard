import { describe, it, expect } from "vite-plus/test";
import type { Context } from "hono";
import { getActiveProject, requireActiveProject } from "@/lib/active-project";
import type { ResolvedActiveProject } from "@/lib/authz";

function makeCtx(
  activeProject: ResolvedActiveProject | null | undefined,
): Context {
  const store = new Map<string, unknown>();
  if (activeProject !== undefined) store.set("activeProject", activeProject);
  return {
    get: (key: string) => store.get(key),
  } as unknown as Context;
}

const sampleActiveProject: ResolvedActiveProject = {
  id: "proj-1",
  teamId: "team-1",
  slug: "web",
  name: "Web",
  teamSlug: "acme",
  teamName: "Acme",
  role: "owner",
};

describe("getActiveProject", () => {
  it("returns null when ctx has no activeProject set", () => {
    expect(getActiveProject(makeCtx(undefined))).toBeNull();
  });

  it("returns null when ctx.activeProject is explicitly null", () => {
    expect(getActiveProject(makeCtx(null))).toBeNull();
  });

  it("returns the resolved active project when set", () => {
    const ap = getActiveProject(makeCtx(sampleActiveProject));
    expect(ap).not.toBeNull();
    expect(ap!.id).toBe("proj-1");
    expect(ap!.teamSlug).toBe("acme");
    expect(ap!.slug).toBe("web");
    expect(ap!.role).toBe("owner");
  });
});

describe("requireActiveProject", () => {
  it("returns the resolved active project when set", () => {
    const ap = requireActiveProject(makeCtx(sampleActiveProject));
    expect(ap.id).toBe("proj-1");
  });

  it("throws a 404 Response when activeProject is missing", () => {
    try {
      requireActiveProject(makeCtx(undefined));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(404);
    }
  });

  it("throws a 404 Response when activeProject is null", () => {
    try {
      requireActiveProject(makeCtx(null));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(404);
    }
  });
});
