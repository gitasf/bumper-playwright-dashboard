import { Check, ChevronsUpDown, FlaskConical, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useRouter } from "@void/react";
import { useNavigate } from "@/lib/navigate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
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
          "hover:bg-accent data-[popup-open]:bg-accent",
          "min-w-0",
        )}
      >
        <TeamBadge name={selectedTeam.name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {selectedTeam.name}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {selectedProject.name}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
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
                  "hover:bg-accent",
                  t.slug === selectedTeam.slug && "bg-accent",
                )}
                onClick={() => switchTeam(t.slug)}
                type="button"
              >
                <TeamBadge name={t.name} size="sm" />
                <span className="flex-1 truncate">{t.name}</span>
                {t.slug === selectedTeam.slug && (
                  <Check className="size-3.5 text-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="my-1.5 h-px bg-border" />

        <SectionLabel>Projects in {selectedTeam.name}</SectionLabel>
        <ul className="flex flex-col">
          {projects.map((p) => (
            <li key={p.slug}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  "font-mono text-[13px]",
                  "hover:bg-accent",
                  p.slug === selectedProject.slug && "bg-accent",
                )}
                onClick={() => switchProject(p.slug)}
                type="button"
              >
                <FlaskConical className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{p.name}</span>
                {p.slug === selectedProject.slug && (
                  <Check className="size-3.5 text-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>

        {isOwner && (
          <>
            <div className="my-1.5 h-px bg-border" />
            <Link
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
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
    <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Solid colored tile with the team initial. Color is derived from the team
 * slug so it's stable across renders. Steel-blue / cool-neutral palette to
 * match the prototype's restrained accent direction.
 */
function TeamBadge({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  const initial = name.charAt(0).toUpperCase();
  const px = size === "sm" ? "size-4 text-[9.5px]" : "size-[22px] text-[12px]";
  const hue = teamHue(name);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white",
        px,
      )}
      style={{ background: `oklch(0.55 0.10 ${hue})` }}
    >
      {initial}
    </span>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function teamHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  // Restrict to a cool 220-290° band so badges stay in the steel/indigo
  // family rather than scattering across the rainbow.
  return 220 + (Math.abs(h) % 70);
}
