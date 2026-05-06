import { Check, Mail, Users, X } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { Button } from "@/app/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import { NotFoundPage } from "@/app/pages/not-found";
import {
  getPendingInvitesForUser,
  getUserTeams,
  type PendingInvite,
} from "@/lib/authz";
import { resolveDefaultLanding } from "@/lib/user-state";
import type { AppContext } from "@/worker";

export async function TeamPickerPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  // Pending invites take priority over the redirect-to-default path: a
  // user with active teams *and* a fresh invite needs the picker so they
  // can accept it. Once invites are dealt with (or declined), the next
  // visit to `/` redirects to their default landing as before.
  const [invites, userTeams] = await Promise.all([
    getPendingInvitesForUser(ctx.user.id),
    getUserTeams(ctx.user.id),
  ]);

  if (invites.length === 0) {
    const target = await resolveDefaultLanding(ctx.user.id);
    if (target) {
      const origin = new URL(requestInfo.request.url).origin;
      const path =
        target.kind === "project"
          ? `/t/${target.teamSlug}/p/${target.projectSlug}`
          : `/t/${target.teamSlug}`;
      return Response.redirect(`${origin}${path}`, 302);
    }
  }

  if (invites.length === 0 && userTeams.length === 0) {
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
            <Button render={<a href="/settings/teams/new">Create a team</a>} />
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

      {invites.length > 0 && <PendingInvitesSection invites={invites} />}

      {userTeams.length > 0 && (
        <section className="mt-6 rounded-lg border border-border bg-card">
          <header className="border-border/50 border-b px-5 py-3">
            <h2 className="font-semibold text-sm tracking-tight">Your teams</h2>
          </header>
          <ul className="divide-y divide-border/50">
            {userTeams.map((t) => (
              <li
                key={t.slug}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <p className="truncate font-medium text-sm">{t.name}</p>
                <a
                  href={`/t/${t.slug}`}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
                >
                  Open
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 text-center">
        <a
          href="/settings/teams/new"
          className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
        >
          Or create your own team →
        </a>
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
              <form
                method="post"
                action={`/api/invites/${inv.id}/decline`}
                className="m-0"
              >
                <button
                  type="submit"
                  aria-label={`Decline invite to ${inv.teamName}`}
                  title="Decline"
                  className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </form>
              <form
                method="post"
                action={`/api/invites/${inv.id}/accept`}
                className="m-0"
              >
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
