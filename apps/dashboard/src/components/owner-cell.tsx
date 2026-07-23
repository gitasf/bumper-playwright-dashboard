import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { Badge } from "@/components/ui/badge";

/**
 * Read-only ownership chips (roadmap 2.3): a test's owners (manual +
 * CODEOWNERS-derived, manual-wins) rendered as avatar badges. Display only —
 * assignment moved off the flaky list into the per-test page's assign popover
 * (`OwnerAssignControl`), which posts to the shared owner mutation route.
 * Shared by the flaky table's Owner column and the test-detail header.
 */

export interface OwnerChip {
  owner: string;
  source: "manual" | "codeowners";
  /** Display label (member NAME for email owners); falls back to `owner`. */
  label?: string;
}

/** One owner chip. CODEOWNERS-derived owners render outlined + annotated.
 *  Shows the display `label` only — never the raw email behind it. */
export function OwnerBadge({ chip }: { chip: OwnerChip }): React.ReactElement {
  const fromCodeowners = chip.source === "codeowners";
  const label = chip.label ?? chip.owner;
  return (
    <Badge
      aria-label={
        fromCodeowners ? `Owner ${label} (from CODEOWNERS)` : `Owner ${label}`
      }
      size="sm"
      title={fromCodeowners ? `${label} (CODEOWNERS)` : label}
      variant={fromCodeowners ? "outline" : "secondary"}
    >
      <ActorAvatar actor={label} size={12} />
      <span className="max-w-[90px] truncate">{label}</span>
    </Badge>
  );
}

export interface OwnerCellProps {
  /** The test's owners (manual + codeowners, manual-wins), `[]` when none. */
  owners: OwnerChip[];
}

export function OwnerCell({ owners }: OwnerCellProps): React.ReactElement {
  if (owners.length === 0) {
    return <span className="text-caption text-fg-3">—</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {owners.map((o) => (
        <OwnerBadge chip={o} key={`${o.source}:${o.owner}`} />
      ))}
    </div>
  );
}
