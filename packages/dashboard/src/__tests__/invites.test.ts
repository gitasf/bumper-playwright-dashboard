/**
 * Tests for the team-invite acceptance flow. Covers the three behaviours that
 * must not regress: tokens are matched by hash (never by plaintext), expired
 * or unknown invites surface an error instead of silently redirecting, and
 * an already-member accept does not burn the invite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbRef, mockBatchControl } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  mockBatchControl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("rwsdk/worker", () => ({
  requestInfo: { request: new Request("https://example.com/") },
}));
vi.mock("@/control", () => ({
  getControlDb: () => dbRef.current,
  batchControl: mockBatchControl,
}));
vi.mock("ulid", () => ({ ulid: () => "membership-01" }));

import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import { acceptInviteHandler } from "../app/pages/invite";
import { generateInviteToken, hashInviteToken } from "../lib/invite-tokens";

const TOKEN = "test-token-abcdef";
let driver: ScriptedDriver;

async function callAccept(): Promise<Response> {
  const ctx = { user: { id: "user-1" } } as unknown as Parameters<
    typeof acceptInviteHandler
  >[0]["ctx"];
  return acceptInviteHandler({
    request: new Request("https://example.com/invite/" + TOKEN, {
      method: "POST",
    }),
    ctx,
    params: { token: TOKEN },
  });
}

describe("acceptInviteHandler", () => {
  beforeEach(() => {
    const t = makeTestDb();
    dbRef.current = t.db;
    driver = t.driver;
    mockBatchControl.mockClear();
  });

  it("looks up the invite by hash, not by plaintext", async () => {
    // Invite row, then membership check, then a successful batch.
    driver.results.push(
      selectResult([
        {
          id: "invite-1",
          teamId: "team-1",
          role: "member",
          teamSlug: "acme",
        },
      ]),
      selectResult([]),
    );

    await callAccept();

    const expectedHash = await hashInviteToken(TOKEN);
    const first = driver.queries[0];
    expect(first.sql).toMatch(/from "teamInvites"/i);
    expect(first.sql).toMatch(/"tokenHash"\s*=\s*\?/);
    expect(first.sql).not.toMatch(/"token"\s*=\s*\?/);
    expect(first.parameters).toContain(expectedHash);
    expect(first.parameters).not.toContain(TOKEN);
  });

  it("inserts membership and deletes the invite atomically on accept", async () => {
    driver.results.push(
      selectResult([
        {
          id: "invite-1",
          teamId: "team-1",
          role: "member",
          teamSlug: "acme",
        },
      ]),
      selectResult([]),
    );

    const res = await callAccept();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/t/acme");
    expect(mockBatchControl).toHaveBeenCalledTimes(1);
    const batched = mockBatchControl.mock.calls[0]?.[0] as Array<{
      compile: () => { sql: string; parameters: readonly unknown[] };
    }>;
    expect(batched).toHaveLength(2);
    const sqls = batched.map((q) => q.compile().sql);
    expect(sqls[0]).toMatch(/insert into "memberships"/i);
    expect(sqls[1]).toMatch(/delete from "teamInvites"/i);
  });

  it("redirects with ?error= when the invite is missing or expired", async () => {
    driver.results.push(selectResult([])); // no row matches

    const res = await callAccept();

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(/\/invite\//);
    expect(location).toMatch(/[?&]error=/);
    expect(mockBatchControl).not.toHaveBeenCalled();
  });

  it("does not burn the invite when the user is already a member", async () => {
    driver.results.push(
      selectResult([
        {
          id: "invite-1",
          teamId: "team-1",
          role: "member",
          teamSlug: "acme",
        },
      ]),
      selectResult([{ id: "existing-membership" }]),
    );

    const res = await callAccept();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/t/acme");
    expect(mockBatchControl).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no authenticated user", async () => {
    const res = await acceptInviteHandler({
      request: new Request("https://example.com/invite/" + TOKEN, {
        method: "POST",
      }),
      ctx: {} as unknown as Parameters<typeof acceptInviteHandler>[0]["ctx"],
      params: { token: TOKEN },
    });
    expect(res.status).toBe(401);
    expect(driver.queries).toHaveLength(0);
  });

  it("rejects a directed invite when the caller's email doesn't match", async () => {
    // Invite row carries a directed email; user lookup returns a different
    // address; account lookup returns no GitHub login. inviteMatchesUser
    // must return false so the redemption is blocked.
    driver.results.push(
      selectResult([
        {
          id: "invite-1",
          teamId: "team-1",
          role: "member",
          email: "joe@example.com",
          githubLogin: null,
          teamSlug: "acme",
        },
      ]),
      selectResult([{ email: "someone-else@example.com" }]),
    );

    const res = await callAccept();

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(/\/invite\//);
    expect(location).toMatch(/[?&]error=/);
    expect(mockBatchControl).not.toHaveBeenCalled();
  });

  it("accepts a directed invite when the caller's email matches (case-folded)", async () => {
    // Invite stored lowercased; user.email comes back mixed-case.
    driver.results.push(
      selectResult([
        {
          id: "invite-1",
          teamId: "team-1",
          role: "member",
          email: "joe@example.com",
          githubLogin: null,
          teamSlug: "acme",
        },
      ]),
      selectResult([{ email: "Joe@Example.COM" }]),
      selectResult([]),
    );

    const res = await callAccept();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/t/acme");
    expect(mockBatchControl).toHaveBeenCalledTimes(1);
  });

  it("accepts a directed invite when the caller's GitHub login matches", async () => {
    // Email check returns no match (or no email); GitHub login matches.
    driver.results.push(
      selectResult([
        {
          id: "invite-1",
          teamId: "team-1",
          role: "member",
          email: null,
          githubLogin: "octocat",
          teamSlug: "acme",
        },
      ]),
      selectResult([{ githubLogin: "octocat" }]),
      selectResult([]),
    );

    const res = await callAccept();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/t/acme");
    expect(mockBatchControl).toHaveBeenCalledTimes(1);
  });
});

describe("invite-token helpers", () => {
  it("generates URL-safe base64 tokens with at least 128 bits of entropy", () => {
    const t = generateInviteToken();
    // 24 random bytes -> 32 base64 chars, minus '=' padding -> 32 chars.
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(32);
  });

  it("produces 64-hex-char SHA-256 hashes and is deterministic", async () => {
    const a = await hashInviteToken("hello");
    const b = await hashInviteToken("hello");
    const c = await hashInviteToken("world");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
