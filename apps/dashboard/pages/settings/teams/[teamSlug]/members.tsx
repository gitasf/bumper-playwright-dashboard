import { useMutation } from "@tanstack/react-query";
import { Mail, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useRouter } from "@void/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RevealOnceDialog } from "@/components/settings/reveal-once-dialog";
import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/initials";
import { formatRelativeTime } from "@/lib/time-format";
import type { MembershipRole } from "@schema";
import type { Props } from "./members.server";

/** Title-case a role for display in the selectors ("owner" → "Owner"). */
function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface CreateInviteResponse {
  invite: {
    id: string;
    role: string;
    createdAt: number;
    expiresAt: number;
    email: string | null;
    githubLogin: string | null;
  };
  url: string;
}

/**
 * A member's role picker. Autosaves on change (no Save button): the picked role
 * is shown optimistically, PATCHed to `/api/teams/:slug/members`, then the page
 * is refreshed to re-sync server truth. On failure (last-owner guard, or the
 * member vanishing) it reverts to the prior role and bubbles the message up via
 * `onError` so the page can surface it in the shared error Alert.
 *
 * The remaining per-row controls (remove / leave / revoke) stay no-JS `<form>`s;
 * only the role change is JS-driven now, which the Base UI `ui/select` requires.
 */
function MemberRoleSelect({
  member,
  teamSlug,
  roles,
  onError,
}: {
  member: { userId: string; name: string; role: MembershipRole };
  teamSlug: string;
  roles: readonly MembershipRole[];
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  // Optimistic value: reflect the pick immediately, revert it if the save fails.
  // Re-seeded per member via the row `key`, and equal to `member.role` again
  // after a successful `router.refresh()`, so it never drifts from server truth.
  const [value, setValue] = useState<MembershipRole>(member.role);

  const save = useMutation<{ role: MembershipRole }, Error, MembershipRole>({
    mutationFn: async (role) => {
      const res = await fetch(`/api/teams/${teamSlug}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ userId: member.userId, role }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not update role.";
        throw new Error(message);
      }
      return (await res.json()) as { role: MembershipRole };
    },
    onSuccess: () => {
      void router.refresh();
    },
    onError: (err) => {
      setValue(member.role);
      onError(err.message);
    },
  });

  return (
    <Select
      disabled={save.isPending}
      onValueChange={(next) => {
        const role = roles.find((r) => r === next) ?? member.role;
        if (role === value) return;
        onError(null);
        setValue(role);
        save.mutate(role);
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={`Role for ${member.name}`}
        className="w-28"
        size="sm"
      >
        <SelectValue>{(v: string) => roleLabel(v)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {roles.map((r) => (
          <SelectItem key={r} value={r}>
            {roleLabel(r)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function formatExpiresIn(
  expiresAt: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const remaining = expiresAt - nowSec;
  if (remaining <= 0) return "expired";
  const days = Math.floor(remaining / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(remaining / 3600);
  if (hours >= 1) return `${hours}h`;
  return "<1h";
}

export default function SettingsTeamMembersPage({
  team,
  members,
  invites,
  currentUserId,
  membersError,
  assignableRoles,
  roleDescriptions,
}: Props) {
  const router = useRouter();
  // `manageMembers` is owner-only today; the role/remove controls render only
  // for owners. `viewSettings` (member) sees the read-only list.
  const canManageMembers = team.role === "owner";
  const here = `/settings/teams/${team.slug}/members`;

  const [identifier, setIdentifier] = useState("");
  const [inviteRole, setInviteRole] = useState<MembershipRole>("member");
  const [revealedInviteUrl, setRevealedInviteUrl] = useState<string | null>(
    null,
  );
  // Client-side error from an autosaved role change (last-owner guard, etc.).
  // Takes precedence over the loader's `membersError` (a no-JS redirect error).
  const [roleError, setRoleError] = useState<string | null>(null);

  const createInvite = useMutation<
    CreateInviteResponse,
    Error,
    { identifier: string; role: string }
  >({
    mutationFn: async ({ identifier: id, role }) => {
      const res = await fetch(`/api/teams/${team.slug}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ identifier: id, role }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not create invite.";
        throw new Error(message);
      }
      return (await res.json()) as CreateInviteResponse;
    },
    onSuccess: (data) => {
      setRevealedInviteUrl(data.url);
      void router.refresh();
    },
  });

  return (
    <SettingsPage>
      <SettingsHeader
        subtitle="People with access to this team's projects and settings."
        title={`${team.name} · Members`}
      />

      {(roleError ?? membersError) && (
        <Alert variant="error">
          <AlertDescription>{roleError ?? membersError}</AlertDescription>
        </Alert>
      )}

      <RevealOnceDialog
        description="Send this single-use link to your teammate. It's valid for 7 days and stops working once accepted."
        onClose={() => setRevealedInviteUrl(null)}
        open={Boolean(revealedInviteUrl)}
        title="Invite link ready"
      >
        <pre className="overflow-x-auto rounded-md border border-line-1 bg-bg-0 p-2.5 font-mono text-[12.5px] text-fg-1">
          {revealedInviteUrl}
        </pre>
      </RevealOnceDialog>

      {canManageMembers && (
        <SettingsCard
          subtitle="They'll get an invite link valid for 7 days."
          title="Invite a teammate"
        >
          <form
            className="m-0 flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              createInvite.mutate({
                identifier: identifier.trim(),
                role: inviteRole,
              });
            }}
          >
            <div className="flex-1">
              <Input
                aria-label="Email or GitHub username"
                autoComplete="off"
                maxLength={254}
                name="inviteIdentifier"
                nativeInput
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="teammate@example.com or github-username"
                value={identifier}
              />
            </div>
            <Select
              // The options are exactly `assignableRoles`; resolve the emitted
              // value back to that typed list (defaulting to member) rather than
              // casting — keeps `inviteRole` a real MembershipRole.
              onValueChange={(v) =>
                setInviteRole(assignableRoles.find((r) => r === v) ?? "member")
              }
              value={inviteRole}
            >
              <SelectTrigger aria-label="Invite role" className="sm:w-32">
                <SelectValue>{(v: string) => roleLabel(v)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {assignableRoles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabel(r)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              disabled={createInvite.isPending}
              loading={createInvite.isPending}
              type="submit"
            >
              <UserPlus className="size-4" />
              Send invite
            </Button>
          </form>
          <p className="mt-2 text-[11.5px] text-fg-3">
            {roleDescriptions[inviteRole]}
          </p>
          <p className="mt-2 text-[11.5px] text-fg-3">
            Email invites match accounts with a verified email (currently GitHub
            sign-ins). For password accounts, invite by GitHub username instead.
          </p>
          {createInvite.error && (
            <Alert className="mt-3" variant="error">
              <AlertDescription>{createInvite.error.message}</AlertDescription>
            </Alert>
          )}
        </SettingsCard>
      )}

      <SettingsCard title={`Members · ${members.length}`}>
        <div className="-mx-[18px] -my-4">
          {members.map((m, i) => (
            <div
              className={cn(
                "flex items-center gap-3 px-[18px] py-3",
                i !== members.length - 1 && "border-b border-line-1",
              )}
              key={m.userId}
            >
              {m.image ? (
                <img
                  alt=""
                  className="size-7 shrink-0 rounded-full border border-line-1 bg-bg-3 object-cover"
                  height={28}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  src={m.image}
                  width={28}
                />
              ) : (
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-1 bg-bg-3 font-mono font-semibold text-[10.5px] text-fg-3">
                  {initials(m.name)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[length:var(--text-fs-14)] text-fg-1">
                  {m.name}
                </div>
                <div className="truncate font-mono text-[11.5px] text-fg-3">
                  {m.email}
                </div>
              </div>
              {canManageMembers ? (
                <MemberRoleSelect
                  member={m}
                  onError={setRoleError}
                  roles={assignableRoles}
                  teamSlug={team.slug}
                />
              ) : (
                <span
                  className={cn(
                    "rounded-sm px-2 py-0.5 font-mono text-[11px] capitalize",
                    m.role === "owner"
                      ? "bg-accent-soft text-accent"
                      : "bg-bg-3 text-fg-2",
                  )}
                >
                  {m.role}
                </span>
              )}
              {canManageMembers && m.userId !== currentUserId && (
                <form
                  action={`${here}?removeMember`}
                  className="m-0"
                  method="post"
                >
                  <input name="userId" type="hidden" value={m.userId} />
                  <Button
                    aria-label={`Remove ${m.name}`}
                    size="xs"
                    type="submit"
                    variant="ghost"
                  >
                    <X className="size-3.5" />
                    Remove
                  </Button>
                </form>
              )}
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        subtitle="You lose access to this team's projects and settings. An owner can invite you back."
        title="Leave team"
      >
        <form action={`${here}?leaveTeam`} className="m-0" method="post">
          <Button type="submit" variant="outline">
            Leave team
          </Button>
        </form>
      </SettingsCard>

      {invites.length > 0 && (
        <SettingsCard title={`Pending invites · ${invites.length}`}>
          <div className="-mx-[18px] -my-4">
            {invites.map((inv, i) => (
              <div
                className={cn(
                  "flex items-center gap-3 px-[18px] py-3",
                  i !== invites.length - 1 && "border-b border-line-1",
                )}
                key={inv.id}
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-bg-3 text-fg-3">
                  <Mail className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] text-fg-1">
                    {inv.email ??
                      (inv.githubLogin
                        ? `@${inv.githubLogin}`
                        : "Open invite link")}
                  </div>
                  <div className="text-[11.5px] text-fg-3">
                    sent {formatRelativeTime(inv.createdAt)} · expires in{" "}
                    {formatExpiresIn(inv.expiresAt)}
                  </div>
                </div>
                <span className="rounded-sm bg-bg-3 px-2 py-0.5 font-mono text-[11px] capitalize text-fg-2">
                  {inv.role}
                </span>
                {canManageMembers && (
                  <form
                    action={`${here}?revokeInvite`}
                    className="m-0"
                    method="post"
                  >
                    <input name="inviteId" type="hidden" value={inv.id} />
                    <Button
                      aria-label="Revoke invite"
                      size="xs"
                      type="submit"
                      variant="ghost"
                    >
                      <X className="size-3.5" />
                      Revoke
                    </Button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </SettingsPage>
  );
}
