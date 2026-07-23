import { use } from "react";
import { DeferredSection } from "@/components/defer-error-boundary";
import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { TablePaginationFooterSkeleton } from "@/components/skeletons";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { formatRelativeTime } from "@/lib/time-format";
import type { AuditEntry, Props } from "./audit.server";

/**
 * Human-readable label per audit action string. Keyed by the same values
 * `AUDIT_ACTIONS` (`src/lib/audit.ts`) emits; an unknown action falls back to
 * the raw string so the page never blanks out on a future action.
 */
const ACTION_LABELS: Record<string, string> = {
  "invite.mint": "Invited a teammate",
  "invite.revoke": "Revoked an invite",
  "invite.accept": "Accepted an invite",
  "member.remove": "Removed a member",
  "member.leave": "Left the team",
  "member.role_change": "Changed a member's role",
  "key.mint": "Created an API key",
  "key.revoke": "Revoked an API key",
  "team.rename": "Renamed the team",
  "team.delete": "Deleted the team",
  "project.create": "Created a project",
  "project.delete": "Deleted a project",
};

/** Tone the action badge by whether the action removes/deletes something. */
function actionVariant(action: string): "secondary" | "error" {
  return action.endsWith(".revoke") ||
    action.endsWith(".remove") ||
    action.endsWith(".delete") ||
    action.endsWith(".leave")
    ? "error"
    : "secondary";
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** A "member" target id is a raw user id; everything else is already readable. */
function targetText(entry: AuditEntry): string {
  if (!entry.targetId) return "—";
  // Member targets store a raw user id; surface a role from metadata when one
  // is present so the row reads "viewer · <id>" rather than a bare opaque id.
  if (
    entry.targetType === "member" &&
    typeof entry.metadata?.role === "string"
  ) {
    return `${entry.metadata.role} · ${entry.targetId}`;
  }
  return entry.targetId;
}

/**
 * Settings → Team → Audit log. The header + "Activity · N" card title paint
 * immediately from the eager count; the row slice (a select + actor-name
 * hydration over the void-owned user table) streams in behind a table skeleton.
 */
export default function SettingsTeamAuditPage({
  team,
  totalCount,
  currentPage,
  totalPages,
  fromRow,
  entries,
}: Props) {
  const pageHref = (page: number) =>
    page <= 1
      ? `/settings/teams/${team.slug}/audit`
      : `/settings/teams/${team.slug}/audit?page=${page}`;

  return (
    <SettingsPage>
      <SettingsHeader
        subtitle="A record of privileged changes — members, invites, API keys, projects, and team settings. Newest first."
        title={`${team.name} · Audit log`}
      />

      <SettingsCard
        className="overflow-hidden"
        title={`Activity · ${totalCount.toLocaleString()}`}
      >
        <DeferredSection
          resetKey={String(currentPage)}
          skeleton={<AuditTableSkeleton totalPages={totalPages} />}
        >
          <AuditTableRegion
            currentPage={currentPage}
            entries={entries}
            fromRow={fromRow}
            pageHref={pageHref}
            totalCount={totalCount}
            totalPages={totalPages}
          />
        </DeferredSection>
      </SettingsCard>
    </SettingsPage>
  );
}

/** The audit table — Empty note or the event rows + pagination footer. Reads
 *  the deferred `entries` group ({ entries, toRow }); the pagination shell
 *  (page/total/fromRow) is eager. */
function AuditTableRegion({
  entries,
  currentPage,
  totalPages,
  fromRow,
  totalCount,
  pageHref,
}: {
  entries: Props["entries"];
  currentPage: number;
  totalPages: number;
  fromRow: number;
  totalCount: number;
  pageHref: (page: number) => string;
}) {
  const { entries: rows, toRow } = use(entries);

  if (rows.length === 0) {
    return (
      <p className="py-2 text-body text-fg-3">
        No activity recorded yet. Privileged changes will show up here.
      </p>
    );
  }

  return (
    <div className="-mx-[18px] -my-4">
      <Table>
        <AuditTableHead />
        <TableBody>
          {rows.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="ps-[18px]">
                <Badge variant={actionVariant(entry.action)}>
                  {actionLabel(entry.action)}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <UserAvatar name={entry.actorName} size={24} />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-body text-fg-1">
                      {entry.actorName}
                    </div>
                    {entry.actorEmail && (
                      <div className="truncate font-mono text-micro text-fg-3">
                        {entry.actorEmail}
                      </div>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell className="max-w-[220px] truncate font-mono text-caption text-fg-2">
                {targetText(entry)}
              </TableCell>
              <TableCell
                className="pe-[18px] text-right font-mono text-caption text-fg-3"
                title={new Date(entry.createdAt * 1000).toISOString()}
              >
                {formatRelativeTime(entry.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePaginationFooter
        currentPage={currentPage}
        fromRow={fromRow}
        itemNoun="event"
        pageHref={pageHref}
        toRow={toRow}
        totalCount={totalCount}
        totalPages={totalPages}
      />
    </div>
  );
}

/** Shared 4-column header used by the live table and its skeleton. */
function AuditTableHead() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="ps-[18px]">Action</TableHead>
        <TableHead>Actor</TableHead>
        <TableHead>Target</TableHead>
        <TableHead className="pe-[18px] text-right">When</TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** Fallback matching the audit table: same 4 columns + a footer strip. The
 *  Actor cell (avatar + two text lines) drives the ~44px row height. Row count
 *  is a fixed placeholder (real count unknown until the slice resolves); the
 *  table is the terminal region in the card, so it resizes in place. */
function AuditTableSkeleton({ totalPages }: { totalPages: number }) {
  return (
    <div className="-mx-[18px] -my-4">
      <Table>
        <AuditTableHead />
        <TableBody>
          {Array.from({ length: 8 }, (_, i) => (
            <TableRow key={i}>
              <TableCell className="ps-[18px]">
                <Skeleton className="h-5 w-32 rounded-full" />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Skeleton className="size-6 shrink-0 rounded-full" />
                  <div className="min-w-0 space-y-1">
                    <Skeleton className="h-[13px] w-24" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-3 w-32" />
              </TableCell>
              <TableCell className="pe-[18px]">
                <Skeleton className="ml-auto h-3 w-16" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePaginationFooterSkeleton showPager={totalPages > 1} />
    </div>
  );
}
