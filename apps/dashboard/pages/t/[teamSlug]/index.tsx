import { Link } from "@/components/ui/link";
import type { Props } from "./index.server";

/**
 * Project picker for a team. Lands here when a user opens a team without
 * choosing a project (or when their last-active project has been deleted).
 * Hardcoded redirect-to-first-project happens in the loader, so this view
 * only renders for empty teams.
 */
export default function ProjectPickerPage({ team }: Props) {
  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <div className="mb-2">
        <Link
          href="/"
          className="text-fg-3 text-sm underline-offset-4 hover:underline"
        >
          &larr; Teams
        </Link>
      </div>
      <h1 className="mb-1 font-semibold text-title">{team.name}</h1>
      <p className="mb-6 text-fg-3">Pick a project to view its test runs.</p>
      <div className="text-fg-3">
        <p className="mb-2">No projects yet.</p>
        {team.role === "owner" && (
          <Link
            href={`/settings/teams/${team.slug}/projects/new`}
            className="text-fg-1 underline-offset-4 hover:underline"
          >
            Create the first project &rarr;
          </Link>
        )}
      </div>
      <div className="mt-8">
        <Link
          href={`/settings/teams/${team.slug}`}
          className="text-fg-3 text-sm underline-offset-4 hover:text-fg-1 hover:underline"
        >
          Manage team &rarr;
        </Link>
      </div>
    </div>
  );
}
