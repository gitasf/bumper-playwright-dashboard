/**
 * Direct unit tests for the per-helper functions in `src/lib/authz.ts`.
 * `resolveTenantBundleForUser` (the single bundled query) lives in
 * `authz-bundle.test.ts` — these cover everything else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({ getControlDb: () => dbRef.current }));

import {
  getPendingInvitesForUser,
  getTeamProjects,
  getTeamRole,
  getUserTeams,
  requireTeamOwner,
  resolveProjectBySlugs,
  resolveTeamBySlug,
} from "../lib/authz";
import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";

let driver: ScriptedDriver;

beforeEach(() => {
  const t = makeTestDb();
  driver = t.driver;
  dbRef.current = t.db;
});

describe("getTeamRole", () => {
  it("returns the role string for a member", async () => {
    driver.results.push(selectResult([{ role: "owner" }]));
    expect(await getTeamRole("u1", "team-1")).toBe("owner");
  });

  it("returns null when no membership row exists", async () => {
    driver.results.push(selectResult([]));
    expect(await getTeamRole("u1", "team-1")).toBeNull();
  });

  it("queries memberships filtered by both userId and teamId", async () => {
    driver.results.push(selectResult([{ role: "member" }]));
    await getTeamRole("user-x", "team-y");
    const q = driver.queries[0];
    expect(q.sql).toMatch(/from "memberships"/i);
    expect(q.parameters).toEqual(expect.arrayContaining(["user-x", "team-y"]));
  });

  it("propagates an unexpected role string verbatim (caller narrows)", async () => {
    driver.results.push(selectResult([{ role: "viewer" }]));
    expect(await getTeamRole("u1", "t1")).toBe("viewer");
  });
});

describe("resolveTeamBySlug", () => {
  it("returns null when no row matches (team missing OR user not a member)", async () => {
    driver.results.push(selectResult([]));
    expect(await resolveTeamBySlug("u1", "ghost")).toBeNull();
  });

  it("returns the team + role when membership exists", async () => {
    driver.results.push(
      selectResult([
        {
          id: "team-1",
          slug: "acme",
          name: "Acme",
          role: "owner",
        },
      ]),
    );
    const team = await resolveTeamBySlug("u1", "acme");
    expect(team).toEqual({
      id: "team-1",
      slug: "acme",
      name: "Acme",
      role: "owner",
    });
  });

  it("joins memberships with userId in the predicate (no team-only leak)", async () => {
    driver.results.push(selectResult([]));
    await resolveTeamBySlug("user-x", "acme");
    const q = driver.queries[0];
    expect(q.sql).toMatch(/inner join "memberships"/i);
    expect(q.parameters).toContain("user-x");
    expect(q.parameters).toContain("acme");
  });
});

describe("getTeamProjects", () => {
  it("returns slug + name pairs scoped to the teamId", async () => {
    driver.results.push(
      selectResult([
        { slug: "web", name: "Web" },
        { slug: "api", name: "API" },
      ]),
    );
    const projects = await getTeamProjects("team-1");
    expect(projects).toEqual([
      { slug: "web", name: "Web" },
      { slug: "api", name: "API" },
    ]);
  });

  it("filters by teamId in the WHERE", async () => {
    driver.results.push(selectResult([]));
    await getTeamProjects("team-xyz");
    expect(driver.queries[0].parameters).toContain("team-xyz");
  });

  it("returns [] for a team with no projects", async () => {
    driver.results.push(selectResult([]));
    expect(await getTeamProjects("team-empty")).toEqual([]);
  });
});

describe("getUserTeams", () => {
  it("returns all teams the user is a member of, by slug + name", async () => {
    driver.results.push(
      selectResult([
        { slug: "a", name: "A" },
        { slug: "b", name: "B" },
      ]),
    );
    expect(await getUserTeams("u1")).toEqual([
      { slug: "a", name: "A" },
      { slug: "b", name: "B" },
    ]);
  });

  it("scopes by userId via the memberships join", async () => {
    driver.results.push(selectResult([]));
    await getUserTeams("user-x");
    const q = driver.queries[0];
    expect(q.sql).toMatch(/inner join "memberships"/i);
    expect(q.parameters).toContain("user-x");
  });
});

describe("getPendingInvitesForUser", () => {
  it("returns [] when the user has no email and no GitHub login", async () => {
    // First two queries fetch user.email and account.githubLogin; both empty.
    driver.results.push(selectResult([]));
    driver.results.push(selectResult([]));
    expect(await getPendingInvitesForUser("u1")).toEqual([]);
    // No invite query issued — short-circuit.
    expect(driver.queries.length).toBe(2);
  });

  it("matches invites by user.email (case-folded) and surfaces matchedBy='email'", async () => {
    driver.results.push(selectResult([{ email: "Joe@Example.COM" }]));
    driver.results.push(selectResult([{ githubLogin: null }]));
    driver.results.push(
      selectResult([
        {
          id: "inv-1",
          teamId: "team-1",
          role: "member",
          email: "joe@example.com",
          inviteGithubLogin: null,
          expiresAt: 9_999_999_999,
          teamSlug: "acme",
          teamName: "Acme",
        },
      ]),
    );
    const invites = await getPendingInvitesForUser("u1");
    expect(invites).toEqual([
      {
        id: "inv-1",
        teamId: "team-1",
        teamSlug: "acme",
        teamName: "Acme",
        role: "member",
        expiresAt: 9_999_999_999,
        matchedBy: "email",
      },
    ]);
  });

  it("matches invites by GitHub login when email doesn't match", async () => {
    driver.results.push(selectResult([{ email: "joe@example.com" }]));
    driver.results.push(selectResult([{ githubLogin: "octocat" }]));
    driver.results.push(
      selectResult([
        {
          id: "inv-2",
          teamId: "team-2",
          role: "owner",
          email: null,
          inviteGithubLogin: "octocat",
          expiresAt: 9_999_999_999,
          teamSlug: "globex",
          teamName: "Globex",
        },
      ]),
    );
    const invites = await getPendingInvitesForUser("u1");
    expect(invites[0].matchedBy).toBe("githubLogin");
  });

  it("filters out expired invites in the SQL (expiresAt > now)", async () => {
    driver.results.push(selectResult([{ email: "joe@example.com" }]));
    driver.results.push(selectResult([{ githubLogin: null }]));
    driver.results.push(selectResult([]));
    await getPendingInvitesForUser("u1");
    const q = driver.queries[2];
    expect(q.sql).toMatch(/"expiresAt"\s*>\s*\?/);
  });
});

describe("requireTeamOwner", () => {
  it("throws 'forbidden' when the team is missing", async () => {
    driver.results.push(selectResult([]));
    await expect(requireTeamOwner("u1", "ghost")).rejects.toThrow("forbidden");
  });

  it("throws 'forbidden' when the user is a member but not an owner", async () => {
    driver.results.push(
      selectResult([
        {
          id: "t1",
          slug: "acme",
          name: "Acme",
          role: "member",
        },
      ]),
    );
    await expect(requireTeamOwner("u1", "acme")).rejects.toThrow("forbidden");
  });

  it("returns id/slug/name when the user is the owner", async () => {
    driver.results.push(
      selectResult([
        {
          id: "t1",
          slug: "acme",
          name: "Acme",
          role: "owner",
        },
      ]),
    );
    expect(await requireTeamOwner("u1", "acme")).toEqual({
      id: "t1",
      slug: "acme",
      name: "Acme",
    });
  });
});

describe("resolveProjectBySlugs", () => {
  it("returns null when neither team nor project exists", async () => {
    driver.results.push(selectResult([]));
    expect(await resolveProjectBySlugs("u1", "x", "y")).toBeNull();
  });

  it("returns the project + role when membership exists", async () => {
    driver.results.push(
      selectResult([
        {
          id: "p1",
          teamId: "t1",
          slug: "web",
          name: "Web",
          teamSlug: "acme",
          role: "owner",
        },
      ]),
    );
    expect(await resolveProjectBySlugs("u1", "acme", "web")).toEqual({
      id: "p1",
      teamId: "t1",
      slug: "web",
      name: "Web",
      teamSlug: "acme",
      role: "owner",
    });
  });

  it("filters by both teamSlug and projectSlug (no project leak across teams)", async () => {
    driver.results.push(selectResult([]));
    await resolveProjectBySlugs("u1", "acme", "web");
    const q = driver.queries[0];
    expect(q.parameters).toContain("acme");
    expect(q.parameters).toContain("web");
    expect(q.parameters).toContain("u1");
  });
});
