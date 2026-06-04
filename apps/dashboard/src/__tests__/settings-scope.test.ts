import { describe, expect, it } from "vite-plus/test";
import {
  AuthzError,
  gateOwnedProject,
  gateTeamScope,
} from "@/lib/settings-scope";
import type { OwnedProject } from "@/lib/settings-scope";
import type { TeamRole } from "@/lib/authz";

/**
 * `gateTeamScope` is the single owner of the one non-obvious invariant the
 * settings-scope seams concentrate: a missing-or-unauthorized team yields a
 * 404 (signalled by `null`), never a 403 — so non-members can't tell a private
 * team apart from a nonexistent one. The async `requireOwnerScope` /
 * `requireMemberScope` seams resolve the membership row, hand it here, and turn
 * a `null` result into a `Response(404)`. Pinning the gate directly keeps the
 * leak-avoidance rule under test without needing the DB resolve.
 */

function team(role: TeamRole) {
  return { id: "team_1", slug: "acme", name: "Acme", role };
}

describe("gateTeamScope", () => {
  describe("member gate (no required role)", () => {
    it("passes an owner through, preserving its role", () => {
      expect(gateTeamScope(team("owner"))).toEqual({
        id: "team_1",
        slug: "acme",
        name: "Acme",
        role: "owner",
      });
    });

    it("passes a plain member through (any role is allowed)", () => {
      expect(gateTeamScope(team("member"))).toEqual({
        id: "team_1",
        slug: "acme",
        name: "Acme",
        role: "member",
      });
    });

    it("404s (returns null) when the team is missing / user is not a member", () => {
      expect(gateTeamScope(null)).toBeNull();
    });
  });

  describe("owner gate (requiredRole = owner)", () => {
    it("passes an owner through", () => {
      expect(gateTeamScope(team("owner"), "owner")).toEqual({
        id: "team_1",
        slug: "acme",
        name: "Acme",
        role: "owner",
      });
    });

    it("404s (returns null) for a non-owner member — 404, not 403", () => {
      expect(gateTeamScope(team("member"), "owner")).toBeNull();
    });

    it("404s (returns null) for a missing team", () => {
      expect(gateTeamScope(null, "owner")).toBeNull();
    });
  });

  it("preserves the role so member-gated pages can hide owner-only UI", () => {
    const result = gateTeamScope(team("member"));
    expect(result?.role).toBe("member");
  });
});

/**
 * `gateOwnedProject` is the project-owner sibling of `gateTeamScope` and the
 * single owner of the same invariant for project-scoped owner gates: a missing
 * project OR a non-owner member is denied (returns `null`) so neither page
 * (404) nor API (403) call site re-derives the predicate. Both API handlers
 * (`keys.ts`) and the page seam (`requireOwnedProjectScope`) now run through
 * `resolveOwnedProject`, which hands the resolved row here; pinning the gate
 * keeps the owner check under test without the DB resolve and independent of
 * how each tier renders the failure.
 */
function ownedProject(role: TeamRole): OwnedProject {
  return {
    id: "proj_1",
    teamId: "team_1",
    slug: "web",
    name: "Web",
    teamSlug: "acme",
    role,
  };
}

describe("gateOwnedProject", () => {
  it("passes an owner-role project through unchanged", () => {
    const project = ownedProject("owner");
    expect(gateOwnedProject(project)).toEqual(project);
  });

  it("denies (returns null) a non-owner member — owner-only operation", () => {
    expect(gateOwnedProject(ownedProject("member"))).toBeNull();
  });

  it("denies (returns null) a missing project / non-membership", () => {
    expect(gateOwnedProject(null)).toBeNull();
  });
});

/**
 * `AuthzError` is the typed discriminant that lets every owner-gated call site
 * tell intentional authz control-flow (not-owner / not-member / missing slug)
 * apart from an infrastructure failure (a D1/transport throw surfaces as a
 * plain `Error`). `resolveOwnedTeam` / `resolveOwnedProject` throw ONLY
 * `AuthzError` for the authz cases, and each caller's catch keys off
 * `instanceof AuthzError`: matched → render 404 (page) / 403 (API); not matched
 * → re-throw so `00.errors.ts` logs it to Cloudflare Tail. Pinning the
 * discriminant here guards against a regression to an untyped `catch {}` that
 * would silently repackage a database outage as "Not Found" (invisible to Tail).
 */
describe("AuthzError (typed authz discriminant)", () => {
  it("is an Error subclass carrying a stable name", () => {
    const err = new AuthzError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuthzError);
    expect(err.name).toBe("AuthzError");
  });

  it("a plain Error (e.g. a D1/transport failure) is NOT an AuthzError", () => {
    // The catch discriminant must let infra failures fall through to be
    // re-thrown + logged to Tail rather than swallowed as a 404/403.
    expect(new Error("D1_ERROR: network failure")).not.toBeInstanceOf(
      AuthzError,
    );
  });
});
