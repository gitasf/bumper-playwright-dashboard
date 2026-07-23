import { FlaskConical, Plus } from "lucide-react";
import { Link } from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { cn } from "@/lib/cn";
import type { Props } from "./projects.server";

export default function SettingsTeamProjectsPage({ team, projects }: Props) {
  const isOwner = team.role === "owner";

  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · Projects`}
        subtitle="A project is one Playwright test suite — usually one repo with one playwright.config."
      />

      <SettingsCard title={`Projects · ${projects.length}`}>
        {projects.length === 0 ? (
          <div className="py-6 text-center text-body text-fg-3">
            No projects yet.
          </div>
        ) : (
          <div className="-mx-[18px] -my-4">
            {projects.map((p, i) => (
              <div
                className={cn(
                  "flex items-center gap-3.5 px-[18px] py-3.5",
                  i !== projects.length - 1 && "border-b border-line-1",
                )}
                key={p.id}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-3 text-fg-2">
                  <FlaskConical className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono font-medium text-body-lg text-fg-1">
                    {p.name}
                  </div>
                  <div className="mt-0.5 text-caption text-fg-3">
                    /t/{team.slug}/p/{p.slug}
                  </div>
                </div>
                <Link
                  className="text-caption font-medium text-fg-3 transition-colors hover:text-fg-1"
                  href={`/settings/teams/${team.slug}/p/${p.slug}/keys`}
                >
                  Project settings
                </Link>
                {isOwner && (
                  <Button
                    render={
                      <Link
                        href={`/settings/teams/${team.slug}/p/${p.slug}/keys`}
                      />
                    }
                    size="sm"
                    variant="outline"
                  >
                    Settings
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {isOwner && (
        <div className="flex justify-end">
          <Button
            render={<Link href={`/settings/teams/${team.slug}/projects/new`} />}
          >
            <Plus className="size-4" />
            New project
          </Button>
        </div>
      )}
    </SettingsPage>
  );
}
