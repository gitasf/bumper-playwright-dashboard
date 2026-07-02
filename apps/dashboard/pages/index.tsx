import { Check, Mail, Users, X } from "lucide-react";
import { Link } from "@void/react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { PendingInvite } from "@/lib/authz";
import type { Props } from "./index.server";

/**
 * Root landing page after sign-in. Shows the team picker — once a user has
 * teams the dashboard auto-routes to their last-active project (handled
 * server-side in the loader), but this page is the explicit fallback when
 * there's nothing to land on or pending invites take priority.
 */
export default function TeamPickerPage({ teams, pendingInvites }: Props) {
  const hasInvites = pendingInvites.length > 0;
  const hasTeams = teams.length > 0;

  if (!hasInvites && !hasTeams) {
    return (
      <div className="mx-auto max-w-2xl p-6 sm:p-8">
        <h1 className="mb-6 font-semibold text-2xl">Your teams</h1>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No teams yet</EmptyTitle>
            <EmptyDescription>
              You&apos;re not a member of any team yet. Create one to start
              collecting Playwright runs.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              render={<Link href="/settings/teams/new">Create a team</Link>}
            />
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <header className="mb-6">
        <h1 className="font-semibold text-2xl tracking-tight">Get started</h1>
      </header>

      {hasInvites && <PendingInvitesSection invites={pendingInvites} />}

      {hasTeams && (
        <section className="mt-6 rounded-lg border border-border bg-card">
          <header className="border-border/50 border-b px-5 py-3">
            <h2 className="font-semibold text-sm tracking-tight">Your teams</h2>
          </header>
          <ul className="divide-y divide-border/50">
            {teams.map((t) => (
              <li
                key={t.slug}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <p className="truncate font-medium text-sm">{t.name}</p>
                <Link
                  href={`/t/${t.slug}`}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 text-center">
        <Link
          href="/settings/teams/new"
          className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
        >
          Or create your own team →
        </Link>
      </div>
    </div>
  );
}

function PendingInvitesSection({ invites }: { invites: PendingInvite[] }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
        <Users size={14} strokeWidth={2} className="text-muted-foreground" />
        <h2 className="font-semibold text-sm tracking-tight">
          Pending invites
        </h2>
        <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          {invites.length}
        </span>
      </header>
      <ul className="divide-y divide-border/50">
        {invites.map((inv) => (
          <li
            key={inv.id}
            className="flex items-center justify-between gap-4 px-5 py-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-muted-foreground">
                <Mail size={14} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <p className="truncate font-medium text-sm">{inv.teamName}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  Invited as {inv.role} ·{" "}
                  {inv.matchedBy === "email"
                    ? "matched by email"
                    : "matched by GitHub login"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <form method="post" action="/?decline" className="m-0">
                <input type="hidden" name="inviteId" value={inv.id} />
                <button
                  type="submit"
                  aria-label={`Decline invite to ${inv.teamName}`}
                  title="Decline"
                  className="inline-flex size-8 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </form>
              <form method="post" action="/?accept" className="m-0">
                <input type="hidden" name="inviteId" value={inv.id} />
                <button
                  type="submit"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
                >
                  <Check size={12} strokeWidth={2.5} />
                  Accept
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
