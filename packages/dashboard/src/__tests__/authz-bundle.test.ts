/**
 * `resolveTenantBundleForUser` is the single ControlDO RPC that
 * `loadActiveProject` middleware fans into ctx for every `/t/:teamSlug/...`
 * request. These tests pin the SQL contract (one SELECT, scoped to
 * `userId`) and the way we partition rows into the four output buckets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({ getControlDb: () => dbRef.current }));

import { resolveTenantBundleForUser } from "../lib/authz";
import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";

let driver: ScriptedDriver;

describe("resolveTenantBundleForUser", () => {
  beforeEach(() => {
    const t = makeTestDb();
    driver = t.driver;
    dbRef.current = t.db;
  });

  it("issues exactly one SELECT, scoped by userId", async () => {
    driver.results.push(selectResult([]));
    await resolveTenantBundleForUser("user-1", "acme", "web");
    expect(driver.queries.length).toBe(1);
    const q = driver.queries[0];
    expect(q.sql).toMatch(/from "memberships"/i);
    expect(q.sql).toMatch(/"memberships"\."userId" = \?/);
    expect(q.parameters).toContain("user-1");
  });

  it("returns empty bundle when the user has no memberships", async () => {
    driver.results.push(selectResult([]));
    const bundle = await resolveTenantBundleForUser("user-1", "acme", "web");
    expect(bundle).toEqual({
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
    });
  });

  it("populates activeTeam + activeProject for an owner of the active team", async () => {
    driver.results.push(
      selectResult([
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "owner",
          projectId: "proj-web",
          projectSlug: "web",
          projectName: "Web",
        },
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "owner",
          projectId: "proj-api",
          projectSlug: "api",
          projectName: "API",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "acme", "web");
    expect(bundle.activeTeam).toEqual({
      id: "team-acme",
      slug: "acme",
      name: "Acme",
      role: "owner",
    });
    expect(bundle.activeProject).toEqual({
      id: "proj-web",
      teamId: "team-acme",
      slug: "web",
      name: "Web",
      teamSlug: "acme",
      teamName: "Acme",
      role: "owner",
    });
    expect(bundle.teamProjects).toEqual([
      { slug: "web", name: "Web" },
      { slug: "api", name: "API" },
    ]);
    expect(bundle.userTeams).toEqual([{ slug: "acme", name: "Acme" }]);
  });

  it("returns role='member' on activeProject for a non-owner", async () => {
    driver.results.push(
      selectResult([
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "member",
          projectId: "proj-web",
          projectSlug: "web",
          projectName: "Web",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "acme", "web");
    expect(bundle.activeProject?.role).toBe("member");
    expect(bundle.activeTeam?.role).toBe("member");
  });

  it("activeProject is null when the project doesn't exist within the team", async () => {
    // Team membership exists, but `:projectSlug` doesn't appear in any row.
    driver.results.push(
      selectResult([
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "owner",
          projectId: "proj-web",
          projectSlug: "web",
          projectName: "Web",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "acme", "ghost");
    expect(bundle.activeTeam).not.toBeNull();
    expect(bundle.activeProject).toBeNull();
  });

  it("activeTeam is null when the user isn't a member of :teamSlug", async () => {
    // Membership rows exist for a different team only — `acme` isn't there.
    driver.results.push(
      selectResult([
        {
          teamId: "team-other",
          teamSlug: "other",
          teamName: "Other",
          role: "member",
          projectId: "proj-x",
          projectSlug: "x",
          projectName: "X",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "acme", "web");
    expect(bundle.activeTeam).toBeNull();
    expect(bundle.activeProject).toBeNull();
    expect(bundle.teamProjects).toEqual([]);
    // Other-team membership still surfaces in userTeams (sidebar shows all).
    expect(bundle.userTeams).toEqual([{ slug: "other", name: "Other" }]);
  });

  it("handles teams with no projects via LEFT JOIN nulls", async () => {
    driver.results.push(
      selectResult([
        {
          teamId: "team-empty",
          teamSlug: "empty",
          teamName: "Empty",
          role: "owner",
          projectId: null,
          projectSlug: null,
          projectName: null,
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "empty", null);
    expect(bundle.activeTeam).not.toBeNull();
    expect(bundle.activeProject).toBeNull();
    expect(bundle.teamProjects).toEqual([]);
    expect(bundle.userTeams).toEqual([{ slug: "empty", name: "Empty" }]);
  });

  it("teamProjects only includes projects in the active team, not other teams", async () => {
    driver.results.push(
      selectResult([
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "owner",
          projectId: "proj-web",
          projectSlug: "web",
          projectName: "Web",
        },
        {
          teamId: "team-other",
          teamSlug: "other",
          teamName: "Other",
          role: "member",
          projectId: "proj-x",
          projectSlug: "x",
          projectName: "X",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "acme", "web");
    expect(bundle.teamProjects).toEqual([{ slug: "web", name: "Web" }]);
    expect(bundle.userTeams).toEqual([
      { slug: "acme", name: "Acme" },
      { slug: "other", name: "Other" },
    ]);
  });

  it("does not require a projectSlug — passing null still resolves the team", async () => {
    driver.results.push(
      selectResult([
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "owner",
          projectId: "proj-web",
          projectSlug: "web",
          projectName: "Web",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", "acme", null);
    expect(bundle.activeTeam?.slug).toBe("acme");
    expect(bundle.activeProject).toBeNull();
    expect(bundle.teamProjects).toEqual([{ slug: "web", name: "Web" }]);
  });

  it("does not require a teamSlug — passing null still returns userTeams", async () => {
    driver.results.push(
      selectResult([
        {
          teamId: "team-acme",
          teamSlug: "acme",
          teamName: "Acme",
          role: "owner",
          projectId: "proj-web",
          projectSlug: "web",
          projectName: "Web",
        },
      ]),
    );
    const bundle = await resolveTenantBundleForUser("user-1", null, null);
    expect(bundle.activeTeam).toBeNull();
    expect(bundle.activeProject).toBeNull();
    expect(bundle.userTeams).toEqual([{ slug: "acme", name: "Acme" }]);
  });
});
