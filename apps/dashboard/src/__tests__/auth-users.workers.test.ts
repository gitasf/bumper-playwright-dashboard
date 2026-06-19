import { describe, expect, it } from "vite-plus/test";
import {
  buildInviteMatchConds,
  coerceAccountCreatedAt,
  identityMatchesInvite,
  inviteMatchedBy,
  projectAuthProfile,
  type UserAccountRow,
  type UserIdentity,
} from "@/lib/auth-users";

/**
 * `auth-users` is the single owner of reads against the void-owned `user` /
 * `account` tables and the directed-invite identity-matching logic that three
 * invite routes used to hand-write. The DB-issuing reads (`getUserIdentity`,
 * `getUsersByIds`, `getUserAccounts`) hit D1 and can't run under the void/db
 * stub, so we pin the PURE half here — the predicate builder and the two
 * match selectors. These carry the security-load-bearing invariants:
 *
 *  - an undirected identity (no email, no github) builds NO match predicate,
 *    so callers 403 instead of redeeming an invite against an empty `or()`;
 *  - the match predicate only ever references the columns the identity
 *    actually carries (never a stray column);
 *  - matching is exact-string against the (already-lowercased) email — a leak
 *    here is an invite-hijack vector, which is why it lives in one place.
 *
 * Under the void/db stub, `eq`/`or` record their args as `{ __op, args }`, so
 * we read back the exact predicate each helper emits.
 */

type RecordedOp = { __op: string; args: readonly unknown[] };
type RecordedColumn = { name?: unknown };

/** Read back `{ column, value }` from a recorded `eq(col, val)` op. */
function readEq(node: unknown): { column: string; value: unknown } {
  const op = node as RecordedOp;
  expect(op.__op).toBe("eq");
  const column = (op.args[0] as RecordedColumn)?.name;
  expect(typeof column).toBe("string");
  return { column: column as string, value: op.args[1] };
}

/** The `(column → value)` pairs ORed together inside a recorded `or(...)`. */
function readOrPairs(node: unknown): Record<string, unknown> {
  const op = node as RecordedOp;
  expect(op.__op).toBe("or");
  const pairs: Record<string, unknown> = {};
  for (const child of op.args) {
    const { column, value } = readEq(child);
    pairs[column] = value;
  }
  return pairs;
}

describe("buildInviteMatchConds", () => {
  it("returns null for an undirected identity (no email, no github)", () => {
    expect(
      buildInviteMatchConds({ email: null, githubLogin: null }),
    ).toBeNull();
  });

  it("matches on email only when only an email is present", () => {
    const conds = buildInviteMatchConds({
      email: "a@b.com",
      githubLogin: null,
    });
    expect(conds).not.toBeNull();
    expect(readOrPairs(conds)).toEqual({ email: "a@b.com" });
  });

  it("matches on github login only when only a github login is present", () => {
    const conds = buildInviteMatchConds({
      email: null,
      githubLogin: "octocat",
    });
    expect(conds).not.toBeNull();
    expect(readOrPairs(conds)).toEqual({ githubLogin: "octocat" });
  });

  it("ORs both columns when both identifiers are present", () => {
    const conds = buildInviteMatchConds({
      email: "a@b.com",
      githubLogin: "octocat",
    });
    expect(readOrPairs(conds)).toEqual({
      email: "a@b.com",
      githubLogin: "octocat",
    });
  });
});

describe("identityMatchesInvite", () => {
  const identity: UserIdentity = {
    email: "a@b.com",
    githubLogin: "octocat",
  };

  it("matches on email", () => {
    expect(
      identityMatchesInvite(identity, { email: "a@b.com", githubLogin: null }),
    ).toBe(true);
  });

  it("matches on github login", () => {
    expect(
      identityMatchesInvite(identity, {
        email: null,
        githubLogin: "octocat",
      }),
    ).toBe(true);
  });

  it("rejects a mismatched email and github login", () => {
    expect(
      identityMatchesInvite(identity, {
        email: "other@b.com",
        githubLogin: "someone-else",
      }),
    ).toBe(false);
  });

  it("rejects when the invite is addressed by a channel the identity lacks", () => {
    const emailOnly: UserIdentity = { email: "a@b.com", githubLogin: null };
    expect(
      identityMatchesInvite(emailOnly, {
        email: null,
        githubLogin: "octocat",
      }),
    ).toBe(false);
  });

  it("does not match a null identity email against a null invite email", () => {
    // Both null must NOT be treated as a match — that would let any account
    // redeem an undirected invite as if it were addressed to them.
    expect(
      identityMatchesInvite(
        { email: null, githubLogin: null },
        { email: null, githubLogin: null },
      ),
    ).toBe(false);
  });
});

describe("inviteMatchedBy", () => {
  const identity: UserIdentity = { email: "a@b.com", githubLogin: "octocat" };

  it("labels an email-addressed invite as 'email'", () => {
    expect(inviteMatchedBy(identity, "a@b.com")).toBe("email");
  });

  it("labels a non-email-matching invite as 'githubLogin'", () => {
    expect(inviteMatchedBy(identity, null)).toBe("githubLogin");
    expect(inviteMatchedBy(identity, "different@b.com")).toBe("githubLogin");
  });

  it("falls back to 'githubLogin' when the identity has no email", () => {
    expect(inviteMatchedBy({ email: null, githubLogin: "octocat" }, null)).toBe(
      "githubLogin",
    );
  });
});

describe("coerceAccountCreatedAt", () => {
  it("converts a Date (timestamptz) to epoch SECONDS", () => {
    expect(coerceAccountCreatedAt(new Date(1_700_000_000_000))).toBe(
      1_700_000_000,
    );
  });

  it("floors sub-second precision", () => {
    // 2023-11-14T22:13:20.500Z → 1700000000.5s → floor → 1700000000
    expect(coerceAccountCreatedAt(new Date("2023-11-14T22:13:20.500Z"))).toBe(
      1_700_000_000,
    );
  });

  it("returns null for null/undefined", () => {
    expect(coerceAccountCreatedAt(null)).toBeNull();
    expect(coerceAccountCreatedAt(undefined)).toBeNull();
  });
});

describe("projectAuthProfile", () => {
  const credential: UserAccountRow = {
    providerId: "credential",
    createdAt: new Date(1_600_000_000_000),
  };
  const github: UserAccountRow = {
    providerId: "github",
    createdAt: new Date(1_700_000_000_000),
  };

  it("reports hasPassword from a credential account row", () => {
    expect(projectAuthProfile([credential], null).hasPassword).toBe(true);
    expect(projectAuthProfile([github], null).hasPassword).toBe(false);
  });

  it("returns null github when no github account row exists", () => {
    expect(projectAuthProfile([credential], "octocat").github).toBeNull();
  });

  it("joins the github account row with the mirror login + coerced connectedAt", () => {
    expect(projectAuthProfile([github], "octocat").github).toEqual({
      login: "octocat",
      connectedAt: 1_700_000_000,
    });
  });

  it("falls back to an empty login + null connectedAt when the mirror is missing", () => {
    // Account row exists but userGithubAccounts hasn't backfilled yet: the page
    // shows "connected" with no @login and no timestamp.
    expect(projectAuthProfile([github], null).github).toEqual({
      login: "",
      connectedAt: null,
    });
  });

  it("handles both providers present together", () => {
    const profile = projectAuthProfile([credential, github], "octocat");
    expect(profile.hasPassword).toBe(true);
    expect(profile.github).toEqual({
      login: "octocat",
      connectedAt: 1_700_000_000,
    });
  });
});
