import { Link } from "@/components/ui/link";
import type { AlertTargets } from "@/lib/monitors/alert-targets";
import { FieldLabel } from "./monitor-form-parts";

export interface AlertRecipientMember {
  userId: string;
  name: string;
  email: string;
}

export interface AlertRecipientGroup {
  id: string;
  name: string;
}

/**
 * The alert-recipient picker fields — radios (`recipientMode`) + group
 * (`group`) / member (`user`) checkboxes — rendered as a slot INSIDE a monitor
 * edit form rather than as a form of their own. There is no `<form>` and no
 * submit button here: the fields ride along in the surrounding
 * `HttpMonitorForm` / `TcpMonitorForm` / `MonitorForm`, so one "Save changes"
 * persists the monitor config and its recipients together (HTML can't nest
 * `<form>`s, and the server's `updateMonitor` action reads these names via
 * `buildAlertTargets`).
 *
 * `alertTargets === null` ⇒ "All team members" (the default; new members are
 * auto-included). Otherwise the explicit member/group selection.
 */
export function AlertRecipientsFields({
  members,
  groups,
  alertTargets,
  teamSlug,
}: {
  members: AlertRecipientMember[];
  groups: AlertRecipientGroup[];
  alertTargets: AlertTargets | null;
  teamSlug: string;
}) {
  const selectedUsers = new Set(alertTargets?.users ?? []);
  const selectedGroups = new Set(alertTargets?.groups ?? []);

  return (
    <div className="border-t border-line-1 pt-4">
      {/* Marker telling the `updateMonitor` action the recipient picker was
          part of this submit — so it persists the selection below. Without it
          the action leaves `alertTargets` untouched (see that action's gate),
          which keeps a future config-only caller from resetting recipients. */}
      <input name="recipientFields" type="hidden" value="1" />
      <div className="mb-3">
        <FieldLabel className="mb-0.5">Alert recipients</FieldLabel>
        <p className="text-[11.5px] text-fg-3">
          Who gets the down/recovery emails for this monitor.{" "}
          <Link
            className="underline"
            href={`/settings/teams/${teamSlug}/groups`}
          >
            Manage groups
          </Link>
          .
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-1.5 text-[13px]">
        <label className="flex items-center gap-2">
          <input
            defaultChecked={alertTargets === null}
            name="recipientMode"
            type="radio"
            value="all"
          />
          All team members
        </label>
        <label className="flex items-center gap-2">
          <input
            defaultChecked={alertTargets !== null}
            name="recipientMode"
            type="radio"
            value="specific"
          />
          Specific members or groups
        </label>
      </div>

      {groups.length > 0 && (
        <div className="mb-3.5">
          <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wider text-fg-3">
            Groups
          </div>
          <div className="flex flex-col gap-1.5">
            {groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2 text-[13px]">
                <input
                  defaultChecked={selectedGroups.has(g.id)}
                  name="group"
                  type="checkbox"
                  value={g.id}
                />
                {g.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wider text-fg-3">
          Members
        </div>
        {members.length === 0 ? (
          <p className="text-[13px] text-fg-3">No members.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {members.map((m) => (
              <label
                key={m.userId}
                className="flex items-center gap-2 text-[13px]"
              >
                <input
                  defaultChecked={selectedUsers.has(m.userId)}
                  name="user"
                  type="checkbox"
                  value={m.userId}
                />
                <span className="font-medium">{m.name}</span>
                <span className="text-fg-3">{m.email}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
