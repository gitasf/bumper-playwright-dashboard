import { Check, ChevronsUpDown, FlaskConical, Plus } from "lucide-react";
import { useState } from "react";
import { useRouter } from "@void/react";
import { Link } from "@/components/ui/link";
import { useNavigate } from "@/lib/navigate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ActorAvatar } from "@/components/actor-avatar";
import { cn } from "@/lib/cn";
import { link } from "@/lib/links";
import type { WorkspaceListItem } from "@/lib/shared-bundle";

interface WorkspaceSwitcherProps {
  selectedTeam: WorkspaceListItem;
  selectedProject: WorkspaceListItem;
  teams: WorkspaceListItem[];
  projects: WorkspaceListItem[];
  isOwner: boolean;
}

/**
 * Sidebar-top picker that combines team + project navigation into a single
 * trigger, mirroring the Wrightful prototype's `TeamProjectMenu`. Replaces
 * the separate `<TeamSwitcher>` (top of sidebar) + `<ProjectSwitcher>` (top
 * header) — the header is gone, so both pickers consolidate here.
 *
 * The popover renders two sections: the user's teams and the projects within
 * the selected team. Selection persistence is handled by middleware (the
 * `wf_workspace` cookie) — navigation alone is enough; no explicit POST.
 */
export function WorkspaceSwitcher({
  selectedTeam,
  selectedProject,
  teams,
  projects,
  isOwner,
}: WorkspaceSwitcherProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const switchTeam = (slug: string) => {
    setOpen(false);
    if (slug === selectedTeam.slug) return;
    navigate(link("/t/:teamSlug", { teamSlug: slug }));
  };

  /**
   * Swap project while keeping the user on the same page when possible.
   *
   * - If the current URL pins a project segment (`/p/<old>/…` under either
   *   `/t/<team>/` or `/settings/teams/<team>/`), rewrite that segment in
   *   place — the middleware updates the workspace cookie on tenant paths,
   *   and SPA navigation keeps state where it is.
   * - Otherwise (e.g. `/settings/profile`, where no project is pinned in the
   *   URL), POST to `/api/user/select-workspace` to update just the cookie,
   *   then refresh the current page so the sidebar + any other shared-state
   *   consumers pick up the new selection.
   */
  const switchProject = (slug: string) => {
    setOpen(false);
    if (slug === selectedProject.slug) return;
    const here = router.path;
    const pinned = new RegExp(`/p/${escapeRegExp(selectedProject.slug)}(/|$)`);
    if (pinned.test(here)) {
      navigate(here.replace(pinned, `/p/${slug}$1`));
      return;
    }
    const body = new FormData();
    body.set("teamSlug", selectedTeam.slug);
    body.set("projectSlug", slug);
    void fetch("/api/user/select-workspace", {
      method: "POST",
      body,
      credentials: "same-origin",
    }).then(() => router.refresh());
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors",
          "hover:bg-bg-3 data-[popup-open]:bg-bg-3",
          "min-w-0",
        )}
      >
        <TeamBadge name={selectedTeam.name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-fg-1">
            {selectedTeam.name}
          </span>
          <span className="truncate font-mono text-micro text-fg-3">
            {selectedProject.name}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-3" />
      </PopoverTrigger>

      <PopoverPopup
        align="start"
        className="w-60 **:data-[slot=popover-viewport]:p-1.5"
      >
        <SectionLabel>Teams</SectionLabel>
        <ul className="flex flex-col">
          {teams.map((t) => (
            <li key={t.slug}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  "hover:bg-bg-3",
                  t.slug === selectedTeam.slug && "bg-bg-3",
                )}
                onClick={() => switchTeam(t.slug)}
                type="button"
              >
                <TeamBadge name={t.name} size="sm" />
                <span className="flex-1 truncate">{t.name}</span>
                {t.slug === selectedTeam.slug && (
                  <Check className="size-3.5 text-fg-1" />
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="my-1.5 h-px bg-line-1" />

        <SectionLabel>Projects in {selectedTeam.name}</SectionLabel>
        <ul className="flex flex-col">
          {projects.map((p) => (
            <li key={p.slug}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  "font-mono text-body",
                  "hover:bg-bg-3",
                  p.slug === selectedProject.slug && "bg-bg-3",
                )}
                onClick={() => switchProject(p.slug)}
                type="button"
              >
                <FlaskConical className="size-3.5 text-fg-3" />
                <span className="flex-1 truncate">{p.name}</span>
                {p.slug === selectedProject.slug && (
                  <Check className="size-3.5 text-fg-1" />
                )}
              </button>
            </li>
          ))}
        </ul>

        {isOwner && (
          <>
            <div className="my-1.5 h-px bg-line-1" />
            <Link
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1"
              href={link("/settings/teams/:teamSlug/projects/new", {
                teamSlug: selectedTeam.slug,
              })}
              onClick={() => setOpen(false)}
            >
              <Plus className="size-3.5" />
              <span>New project</span>
            </Link>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-caption font-medium tracking-[0.1px] text-fg-3">
      {children}
    </div>
  );
}

/**
 * Solid colored tile with the team initial — the same hued-initial treatment
 * as run actors, so it delegates to {@link ActorAvatar} to stay in lockstep
 * with it (shape, hue, typography). Color is derived from the team name so
 * it's stable across renders.
 */
function TeamBadge({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  return <ActorAvatar actor={name} size={size === "sm" ? 16 : 22} />;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
