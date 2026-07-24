"use client";

import { UserRoundPlusIcon, UsersIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { ComboboxFilterPopup } from "@/components/filter-controls";
import { OwnerBadge, type OwnerChip } from "@/components/owner-cell";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxTrigger,
} from "@/components/ui/combobox";

/**
 * The test-ownership affordance on the test detail pages (roadmap 2.3): a
 * Linear-style assignee button. The button IS the state — it shows the current
 * owner (avatar + name) or a muted "Assign" when unowned — and opens a
 * searchable single-select popup (the same `ComboboxFilterPopup` shape as the
 * branch filter) listing the whole team plus each member. ONE owner at a time:
 * picking an option commits immediately (no Save step) by POSTing the full
 * replacement (`intent=set`, one `owner` field) to the shared session-authed
 * mutation route; "No owner" posts an empty set, clearing manual ownership and
 * un-shadowing CODEOWNERS-derived owners per `mergeOwners`.
 *
 * Non-owners see a read-only chip instead of the button (the mutation is
 * owner-gated server-side too); nothing renders when there's also no owner.
 *
 * Owner labels stay the opaque strings the repo stores: a member's email,
 * `@<teamSlug>` for the whole team, or a legacy free-text label (folded into
 * the options so it stays displayable + replaceable). Legacy multi-owner rows
 * render as "first +N" in the button; the next pick converges them to one.
 */

export interface AssignableMember {
  name: string;
  email: string;
}

export interface OwnerAssignControlProps {
  /** `/api/t/:teamSlug/p/:projectSlug/owners`. */
  actionPath: string;
  /** Where to return after the mutation — the current page URL+query. */
  redirectTo: string;
  testId: string;
  /** Human-readable test title for the accessible trigger label. */
  title?: string;
  /** The test's resolved owners (manual + codeowners, manual-wins). */
  owners: OwnerChip[];
  /** Only owners get the assign control; everyone sees the current owner. */
  canManage: boolean;
  team: { slug: string; name: string };
  /** Selectable team members; empty for non-managers (never loaded). */
  members: AssignableMember[];
}

/** Sentinel option that clears manual ownership. */
const NO_OWNER = "__no_owner__";

export function OwnerAssignControl({
  actionPath,
  redirectTo,
  testId,
  title,
  owners,
  canManage,
  team,
  members,
}: OwnerAssignControlProps): React.ReactElement | null {
  const teamValue = `@${team.slug}`;
  const manualOwners = useMemo(
    () => owners.filter((o) => o.source === "manual").map((o) => o.owner),
    [owners],
  );
  const current = manualOwners[0] ?? null;

  // Selectable values: clear (only when someone is assigned), the whole team,
  // each member (by email), plus the currently-assigned label when it's none
  // of those (legacy free text).
  const { items, labelByValue } = useMemo(() => {
    const labels = new Map<string, string>([
      [NO_OWNER, "No owner"],
      [teamValue, team.name],
    ]);
    for (const m of members) {
      if (!labels.has(m.email)) labels.set(m.email, m.name);
    }
    for (const owner of manualOwners) {
      if (!labels.has(owner)) labels.set(owner, owner);
    }
    const list = [...labels.keys()].filter(
      (v) => v !== NO_OWNER || manualOwners.length > 0,
    );
    return { items: list, labelByValue: labels };
  }, [teamValue, team.name, members, manualOwners]);

  const labelFor = (value: string): string => labelByValue.get(value) ?? value;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const ownerInputRef = useRef<HTMLInputElement | null>(null);
  // Control the combobox input ourselves so selecting a value doesn't leave
  // its label in the input (Base UI's default single-select behavior), which
  // would then filter the list down to only matching items on the next open.
  const [query, setQuery] = useState("");

  // Commit a selection: point the hidden `owner` field at the choice (or drop
  // the field entirely for a clear — `intent=set` with zero owners) and submit
  // the plain form. The route redirects back here, so the button re-renders
  // from fresh loader data.
  const commit = (owner: string | null) => {
    const form = formRef.current;
    const input = ownerInputRef.current;
    if (!form || !input) return;
    input.disabled = owner === null;
    if (owner !== null) input.value = owner;
    form.requestSubmit();
  };

  // The effective owner shown in the button: the manual assignee, else the
  // CODEOWNERS-derived owner(s). Extra resolved owners collapse into "+N".
  // Display text prefers the option map (team name, member names), then the
  // server-resolved label — never the raw email.
  const display = owners[0] ?? null;
  const displayLabel = display
    ? (labelByValue.get(display.owner) ?? display.label ?? display.owner)
    : null;
  const extraCount = owners.length - 1;

  if (!canManage) {
    // Read-only: the resolved owner chip(s), nothing when unowned.
    if (owners.length === 0) return null;
    return (
      <div className="flex min-w-0 shrink items-center gap-1">
        {owners.map((o) => (
          <OwnerBadge chip={o} key={`${o.source}:${o.owner}`} />
        ))}
      </div>
    );
  }

  return (
    <>
      <Combobox<string>
        filter={(value, q) => {
          const needle = q.trim().toLowerCase();
          if (!needle) return true;
          return (
            value.toLowerCase().includes(needle) ||
            labelFor(value).toLowerCase().includes(needle)
          );
        }}
        inputValue={query}
        itemToStringLabel={labelFor}
        items={items}
        onInputValueChange={setQuery}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(next: string | null) => {
          // Re-clicking the current selection deselects in Base UI → treat as
          // a no-op; clearing goes through the explicit "No owner" row.
          if (next === null || next === current) return;
          commit(next === NO_OWNER ? null : next);
        }}
        value={current}
      >
        <ComboboxTrigger
          ref={triggerRef}
          render={
            <Button
              aria-label={
                display && displayLabel
                  ? `Change owner of ${title ?? testId} (currently ${displayLabel})`
                  : `Assign an owner to ${title ?? testId}`
              }
              size="sm"
              variant="outline"
            >
              {display && displayLabel ? (
                <>
                  {display.owner === teamValue ? (
                    <UsersIcon className="size-3.5 text-fg-3" />
                  ) : (
                    <ActorAvatar actor={displayLabel} size={14} />
                  )}
                  <span
                    className="max-w-40 truncate"
                    title={
                      display.source === "codeowners"
                        ? `${displayLabel} (CODEOWNERS)`
                        : displayLabel
                    }
                  >
                    {displayLabel}
                  </span>
                  {extraCount > 0 && (
                    <span className="text-fg-3">+{extraCount}</span>
                  )}
                </>
              ) : (
                <>
                  <UserRoundPlusIcon className="size-3.5 text-fg-3" />
                  <span className="text-fg-2">Assign</span>
                </>
              )}
            </Button>
          }
        />
        <ComboboxFilterPopup
          anchor={triggerRef}
          className="w-64"
          footer={
            display?.source === "codeowners" ? (
              <p className="border-t border-line-1 px-3 py-2 text-caption text-fg-3">
                Owned via CODEOWNERS — assigning here overrides it.
              </p>
            ) : undefined
          }
          renderRow={(value: string) => (
            <ComboboxItem key={value} value={value}>
              {value === NO_OWNER ? (
                <span className="text-fg-3">No owner</span>
              ) : value === teamValue ? (
                <span className="flex min-w-0 items-center gap-2">
                  <UsersIcon className="size-3.5 shrink-0 text-fg-3" />
                  <span className="truncate">{team.name}</span>
                  <span className="shrink-0 text-micro text-fg-3">
                    everyone
                  </span>
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-2">
                  <ActorAvatar actor={labelFor(value)} size={14} />
                  <span className="truncate">{labelFor(value)}</span>
                </span>
              )}
            </ComboboxItem>
          )}
          searchable
          searchPlaceholder="Assign to…"
        />
      </Combobox>
      {/* The commit vehicle: a plain POST to the owners route (same redirect
       * flow as the quarantine control). `owner` is pointed at the selection
       * (or disabled = cleared) in `commit` before requestSubmit. */}
      <form action={actionPath} className="hidden" method="post" ref={formRef}>
        <input name="intent" type="hidden" value="set" />
        <input name="testId" type="hidden" value={testId} />
        <input name="redirectTo" type="hidden" value={redirectTo} />
        <input name="owner" ref={ownerInputRef} type="hidden" />
      </form>
    </>
  );
}
