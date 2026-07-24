import { Pencil, Trash2, Users } from "lucide-react";
import { Link } from "@/components/ui/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import type { Props } from "./groups.server";

type Member = Props["members"][number];

/** Checkbox list of members for a create/edit form. */
function MemberChecklist({
  members,
  selected,
}: {
  members: Member[];
  selected: Set<string>;
}) {
  if (members.length === 0) {
    return <p className="text-fg-3 text-body">No members yet.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {members.map((m) => (
        <label key={m.userId} className="flex items-center gap-2 text-body">
          <input
            type="checkbox"
            name="member"
            value={m.userId}
            defaultChecked={selected.has(m.userId)}
          />
          <span className="font-medium">{m.name}</span>
          <span className="text-fg-3">{m.email}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Settings → Team → Groups. Named sets of members, usable as monitor alert
 * recipients (and reusable elsewhere). Owners can create / edit / delete;
 * other members see a read-only list.
 */
export default function SettingsTeamGroupsPage({
  team,
  groups,
  members,
  role,
  editGroupId,
  groupsError,
}: Props) {
  const here = `/settings/teams/${team.slug}/groups`;
  const isOwner = role === "owner";
  const memberName = new Map(members.map((m) => [m.userId, m.name]));

  return (
    <SettingsPage>
      <SettingsHeader
        title="Groups"
        subtitle="Named sets of members. Use them to choose who a monitor alerts, without picking people one by one."
      />

      {groupsError && (
        <Alert className="mb-4" variant="error">
          <AlertDescription>{groupsError}</AlertDescription>
        </Alert>
      )}

      {isOwner && (
        <SettingsCard
          title="New group"
          subtitle="Name it and pick its members."
        >
          <form action={`${here}?createGroup`} className="m-0" method="post">
            <div className="mb-3 max-w-sm">
              <Input name="name" placeholder="e.g. On-call" required />
            </div>
            <MemberChecklist members={members} selected={new Set()} />
            <div className="mt-4">
              <SubmitButton size="sm">Create group</SubmitButton>
            </div>
          </form>
        </SettingsCard>
      )}

      {groups.length === 0 ? (
        <SettingsCard title="Groups">
          <p className="text-fg-3 text-body">
            No groups yet.
            {isOwner ? " Create one above." : ""}
          </p>
        </SettingsCard>
      ) : (
        groups.map((group) => {
          const editing = editGroupId === group.id;
          return (
            <SettingsCard
              key={group.id}
              data-testid="group-card"
              title={
                <span className="inline-flex items-center gap-2">
                  <Users className="size-4 text-fg-3" />
                  {group.name}
                </span>
              }
              subtitle={`${group.memberIds.length} member${
                group.memberIds.length === 1 ? "" : "s"
              }`}
            >
              {editing && isOwner ? (
                <form
                  action={`${here}?saveGroup`}
                  className="m-0"
                  method="post"
                >
                  <input name="groupId" type="hidden" value={group.id} />
                  <div className="mb-3 max-w-sm">
                    <Input name="name" defaultValue={group.name} required />
                  </div>
                  <MemberChecklist
                    members={members}
                    selected={new Set(group.memberIds)}
                  />
                  <div className="mt-4 flex items-center gap-2">
                    <SubmitButton size="sm">Save</SubmitButton>
                    <Button
                      render={<Link href={here} />}
                      size="sm"
                      variant="outline"
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-body">
                    {group.memberIds.length === 0 ? (
                      <span className="text-fg-3">No members.</span>
                    ) : (
                      group.memberIds
                        .map((id) => memberName.get(id) ?? "(removed)")
                        .join(", ")
                    )}
                  </p>
                  {isOwner && (
                    <div className="flex items-center gap-2">
                      <Button
                        render={<Link href={`${here}?editGroup=${group.id}`} />}
                        size="sm"
                        variant="outline"
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </Button>
                      <form
                        action={`${here}?deleteGroup`}
                        className="m-0"
                        method="post"
                      >
                        <input name="groupId" type="hidden" value={group.id} />
                        <Button size="sm" type="submit" variant="outline">
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </form>
                    </div>
                  )}
                </div>
              )}
            </SettingsCard>
          );
        })
      )}
    </SettingsPage>
  );
}
