import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The ownership state surfaced per row on the flaky page (roadmap 2.3): chips
 * for the test's owners (manual + CODEOWNERS-derived, manual-wins) plus — for
 * OWNERS only — an "Assign owner" control and a remove (×) affordance on each
 * MANUAL chip. Non-owners see the chips but no control (the mutation is
 * owner-gated server-side too).
 *
 * CODEOWNERS-derived owners cannot be removed here (they come from the repo's
 * file, not a manual row) — only manual owners get the remove affordance. The
 * controls are plain `<form>` POSTs to the shared session-authed mutation route
 * (`/api/t/:teamSlug/p/:projectSlug/owners`), so they work without JS and keep
 * the flaky page isomorphic (no per-row island). `redirectTo` returns the user
 * to the page they acted from.
 */

export interface OwnerChip {
  owner: string;
  source: "manual" | "codeowners";
}

export interface OwnerCellProps {
  /** `/api/t/:teamSlug/p/:projectSlug/owners`. */
  actionPath: string;
  /** Where to return after the mutation — the current page URL+query. */
  redirectTo: string;
  testId: string;
  /**
   * Human-readable test title, used to build per-row accessible labels so a
   * screen reader hears "Assign owner to <test>" rather than identical labels.
   */
  title?: string;
  /** The test's owners (manual + codeowners, manual-wins), `[]` when none. */
  owners: OwnerChip[];
  /** Only owners get the mutating controls; everyone sees the chips. */
  canManage: boolean;
}

export function OwnerCell({
  actionPath,
  redirectTo,
  testId,
  title,
  owners,
  canManage,
}: OwnerCellProps): React.ReactElement {
  const label = title ?? testId;

  return (
    // `relative z-[1]` lifts the controls above the row's stretched-link overlay
    // so the form inputs stay interactive instead of triggering row navigation.
    <div className="relative z-[1] flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {owners.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">—</span>
        ) : (
          owners.map((o) => (
            <span
              className="inline-flex items-center"
              key={`${o.source}:${o.owner}`}
            >
              <Badge
                aria-label={
                  o.source === "codeowners"
                    ? `Owner ${o.owner} (from CODEOWNERS)`
                    : `Owner ${o.owner}`
                }
                size="sm"
                title={
                  o.source === "codeowners"
                    ? `${o.owner} (CODEOWNERS)`
                    : o.owner
                }
                variant={o.source === "codeowners" ? "outline" : "secondary"}
              >
                <ActorAvatar actor={o.owner} size={12} />
                <span className="max-w-[90px] truncate">{o.owner}</span>
              </Badge>
              {canManage && o.source === "manual" && (
                <form action={actionPath} className="m-0 ml-0.5" method="post">
                  <input name="intent" type="hidden" value="remove" />
                  <input name="testId" type="hidden" value={testId} />
                  <input name="owner" type="hidden" value={o.owner} />
                  <input name="redirectTo" type="hidden" value={redirectTo} />
                  <Button
                    aria-label={`Remove owner ${o.owner} from ${label}`}
                    size="xs"
                    type="submit"
                    variant="ghost"
                  >
                    ×
                  </Button>
                </form>
              )}
            </span>
          ))
        )}
      </div>
      {canManage && (
        <form
          action={actionPath}
          className="m-0 flex items-center gap-1"
          method="post"
        >
          <input name="intent" type="hidden" value="assign" />
          <input name="testId" type="hidden" value={testId} />
          <input name="redirectTo" type="hidden" value={redirectTo} />
          <Input
            aria-label={`Assign owner to ${label}`}
            className="w-[120px]"
            maxLength={256}
            name="owner"
            nativeInput
            placeholder="@team/web"
            required
            size="sm"
          />
          <Button size="sm" type="submit" variant="outline">
            Assign
          </Button>
        </form>
      )}
    </div>
  );
}
