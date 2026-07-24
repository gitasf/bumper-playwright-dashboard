import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { db } from "void/db";
import { ulid } from "ulid";
import { teamInvites, type MembershipRole } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { AuthzError, resolveOwnedTeam } from "@/lib/settings-scope";
import { roleSchema } from "@/lib/members-repo";
import { readBodyField } from "@/lib/form";
import { generateInviteToken, hashInviteToken } from "@/lib/invite-tokens";

const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

type DirectedInvite =
  | { kind: "none" }
  | { kind: "email"; value: string }
  | { kind: "githubLogin"; value: string }
  | { kind: "invalid" };

function parseInviteIdentifier(raw: string): DirectedInvite {
  if (raw === "") return { kind: "none" };
  if (raw.includes("@")) {
    const value = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { kind: "invalid" };
    return { kind: "email", value };
  }
  const value = raw.toLowerCase();
  if (!GITHUB_LOGIN_RE.test(value)) return { kind: "invalid" };
  return { kind: "githubLogin", value };
}

/**
 * POST /api/teams/:teamSlug/invites
 *
 * Owner-only. Mints a single-use invite (optionally directed at an email or
 * a GitHub login) and returns the new invite row + the plaintext URL in the
 * response body so the client can surface it in a modal. Replaces the
 * server-side `createInvite` action on the members page.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  let team: Awaited<ReturnType<typeof resolveOwnedTeam>>;
  try {
    team = await resolveOwnedTeam(c);
  } catch (err) {
    if (err instanceof AuthzError) return c.json({ error: "Not found" }, 404);
    throw err;
  }

  const rawIdentifier = await readBodyField(c, {
    jsonKey: "identifier",
    formKey: "inviteIdentifier",
  });

  const directed = parseInviteIdentifier(rawIdentifier);
  if (directed.kind === "invalid") {
    return c.json(
      {
        error:
          "Enter an email address or a GitHub username (letters, numbers, single hyphens).",
      },
      400,
    );
  }

  // Role the invitee joins as. Validated against the shared role list; defaults
  // to `member` (the pre-3.1 hardcoded value) when omitted. Owner-only mint —
  // the resolveOwnedTeam gate above already requires it — so an owner may
  // invite at any role, including owner.
  const rawRole = await readBodyField(c, { jsonKey: "role", formKey: "role" });
  let role: MembershipRole = "member";
  if (rawRole !== "") {
    const parsedRole = roleSchema.safeParse(rawRole);
    if (!parsedRole.success) {
      return c.json({ error: "Pick a valid role for the invite." }, 400);
    }
    role = parsedRole.data;
  }

  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  const inviteId = ulid();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + INVITE_TTL_SECONDS;

  try {
    await db.insert(teamInvites).values({
      id: inviteId,
      teamId: team.id,
      tokenHash,
      role,
      createdBy: user.id,
      createdAt: nowSeconds,
      expiresAt,
      email: directed.kind === "email" ? directed.value : null,
      githubLogin: directed.kind === "githubLogin" ? directed.value : null,
    });
  } catch {
    return c.json(
      { error: "Could not create invite — please try again." },
      500,
    );
  }

  // Audit the mint (best-effort — never blocks the invite). The directed
  // identity (email / github login) is the human-readable target; the role is
  // metadata so the log shows what access was granted.
  await recordAudit(c, {
    teamId: team.id,
    action: AUDIT_ACTIONS.INVITE_MINT,
    targetType: "invite",
    targetId:
      directed.kind === "email"
        ? directed.value
        : directed.kind === "githubLogin"
          ? `@${directed.value}`
          : "open invite link",
    metadata: { role, inviteId },
  });

  const url = new URL(c.req.url);
  const inviteUrl = `${url.origin}/invite/${token}`;

  return c.json({
    invite: {
      id: inviteId,
      role,
      createdAt: nowSeconds,
      expiresAt,
      email: directed.kind === "email" ? directed.value : null,
      githubLogin: directed.kind === "githubLogin" ? directed.value : null,
    },
    url: inviteUrl,
  });
});
