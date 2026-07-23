import { useQuery } from "@tanstack/react-query";
import {
  BarChart2,
  Boxes,
  CheckSquare,
  Clock,
  FlaskConical,
  Settings,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { fetch } from "void/client";
import { useNavigate } from "@/lib/navigate";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "@/components/ui/command";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { link } from "@/lib/links";

interface Team {
  slug: string;
  name: string;
}

interface Project {
  slug: string;
  name: string;
}

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTeam: Team | null;
  activeProject: Project | null;
  teams: Team[];
  projects: Project[];
}

type Action = () => void;

interface CommandEntry {
  /** Stable, unique React key — decoupled from `value` (names aren't unique). */
  id: string;
  /**
   * The string the Autocomplete filters against (substring, case-insensitive).
   * Server-search results put their searchable text here so they survive the
   * client filter; static items use their human-readable label.
   */
  value: string;
  label: string;
  /** Optional secondary mono text (project slug, file path, branch · sha). */
  hint?: string;
  icon: typeof CheckSquare;
  /** Render the label in a mono font (project switcher). */
  mono?: boolean;
  action: Action;
}

interface CommandGroupSpec {
  /** Group label shown in the popup. */
  value: string;
  items: CommandEntry[];
}

/**
 * ⌘K command menu built on the COSS `Command` primitive (Base UI Autocomplete
 * underneath, `list` mode = client-side substring filtering on each item's
 * `value`). Two kinds of groups:
 *
 *  - **Static navigation** (memoized on tenant context): navigate within the
 *    active project, switch project, switch team — filtered client-side.
 *  - **Server search** (roadmap 4.1c): the debounced input drives a session-
 *    authed, project-scoped GET `/api/t/:teamSlug/p/:projectSlug/search`. With
 *    a BLANK query it surfaces a "Recent runs" group; while typing it surfaces
 *    a "Tests" group whose item `value` (title + file) contains the query, so
 *    the server-matched rows pass the client filter. Fetch is gated on
 *    `open && a project context` and debounced, so it never fires per-keystroke
 *    or while the menu is closed.
 *
 * Selection fires the entry's `action` via the item's `onClick`.
 */
export function CommandMenu({
  open,
  onOpenChange,
  activeTeam,
  activeProject,
  teams,
  projects,
}: CommandMenuProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmed = debouncedQuery.trim();

  // Reset the typed query whenever the menu closes so a re-open starts clean
  // (and the recent-runs group, not stale search results, shows first).
  // Compared during render (not an effect) so the reset lands in the same
  // render that flips `open`, not a frame later.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (!open) setQuery("");
  }

  const teamSlug = activeTeam?.slug;
  const projectSlug = activeProject?.slug;
  const hasProject = teamSlug !== undefined && projectSlug !== undefined;

  // Project-scoped search backing the Recent-runs + Tests groups. `enabled`
  // gates it on an open menu + a resolved project, so the `?? ""` fallbacks
  // below are never actually sent.
  const search = useQuery({
    queryKey: ["command-search", teamSlug, projectSlug, trimmed],
    queryFn: () =>
      fetch("/api/t/:teamSlug/p/:projectSlug/search", {
        params: { teamSlug: teamSlug ?? "", projectSlug: projectSlug ?? "" },
        query: { q: trimmed },
      }),
    enabled: open && hasProject,
    staleTime: 15_000,
  });

  const base =
    teamSlug !== undefined && projectSlug !== undefined
      ? link("/t/:teamSlug/p/:projectSlug", { teamSlug, projectSlug })
      : null;

  const staticGroups: CommandGroupSpec[] = useMemo(() => {
    const result: CommandGroupSpec[] = [];
    const go = (href: string) => {
      onOpenChange(false);
      navigate(href);
    };

    if (activeTeam && activeProject && base) {
      result.push({
        value: "Navigate",
        items: [
          {
            id: "nav:runs",
            value: "Runs",
            label: "Runs",
            icon: CheckSquare,
            action: () => go(base),
          },
          {
            id: "nav:flaky",
            value: "Flaky tests",
            label: "Flaky tests",
            icon: TriangleAlert,
            action: () => go(`${base}/flaky`),
          },
          {
            id: "nav:tests",
            value: "Tests",
            label: "Tests",
            icon: FlaskConical,
            action: () => go(`${base}/tests`),
          },
          {
            id: "nav:insights",
            value: "Insights",
            label: "Insights",
            icon: BarChart2,
            action: () => go(`${base}/insights`),
          },
          {
            id: "nav:settings",
            value: "Settings",
            label: "Settings",
            icon: Settings,
            action: () => go("/settings/profile"),
          },
        ],
      });
    }

    if (activeTeam && projects.length > 0) {
      result.push({
        value: `Switch project in ${activeTeam.name}`,
        items: projects.map<CommandEntry>((p) => ({
          // Keyed by slug — project NAMES aren't unique within a team.
          id: `project:${p.slug}`,
          value: p.name,
          label: p.name,
          icon: Boxes,
          mono: true,
          action: () =>
            go(
              link("/t/:teamSlug/p/:projectSlug", {
                teamSlug: activeTeam.slug,
                projectSlug: p.slug,
              }),
            ),
        })),
      });
    }

    if (teams.length > 1) {
      result.push({
        value: "Switch team",
        items: teams.map<CommandEntry>((t) => ({
          id: `team:${t.slug}`,
          value: t.name,
          label: t.name,
          icon: Users,
          action: () => go(link("/t/:teamSlug", { teamSlug: t.slug })),
        })),
      });
    }

    return result;
    // navigate is stable from Void; only re-derive when tenant context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, activeProject, teams, projects, base]);

  const serverGroups: CommandGroupSpec[] = useMemo(() => {
    if (!base) return [];
    const go = (href: string) => {
      onOpenChange(false);
      navigate(href);
    };
    const data = search.data;
    if (!data) return [];

    // Blank query → recent runs (query-independent); typing → matching tests.
    if (trimmed === "") {
      if (data.runs.length === 0) return [];
      return [
        {
          value: "Recent runs",
          items: data.runs.map<CommandEntry>((r) => ({
            id: `run:${r.id}`,
            value: r.commitMessage ?? r.branch ?? r.id,
            label: r.commitMessage ?? r.branch ?? `Run ${r.id.slice(-7)}`,
            hint: [r.branch, r.commitSha?.slice(0, 7)]
              .filter(Boolean)
              .join(" · "),
            icon: Clock,
            action: () => go(`${base}/runs/${r.id}`),
          })),
        },
      ];
    }

    if (data.tests.length === 0) return [];
    return [
      {
        value: "Tests",
        items: data.tests.map<CommandEntry>((t) => ({
          id: `test:${t.testId}`,
          // title + file both carry the server-matched term, so the row passes
          // the client substring filter against the typed query.
          value: `${t.title} ${t.file}`,
          label: t.title,
          hint: t.file,
          icon: FlaskConical,
          action: () => go(`${base}/tests?q=${encodeURIComponent(t.title)}`),
        })),
      },
    ];
    // navigate is stable from Void.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, search.data, trimmed]);

  // When typing, lead with search results; otherwise lead with navigation.
  const groups = useMemo(
    () =>
      trimmed === ""
        ? [...staticGroups, ...serverGroups]
        : [...serverGroups, ...staticGroups],
    [trimmed, staticGroups, serverGroups],
  );

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandDialogPopup>
        <Command items={groups} onValueChange={setQuery} value={query}>
          <CommandInput placeholder="Search runs, tests, projects…" />
          <CommandPanel>
            <CommandEmpty>No matches</CommandEmpty>
            <CommandList>
              {(group: CommandGroupSpec, groupIndex: number) => (
                <Fragment key={group.value}>
                  {groupIndex > 0 && <CommandSeparator />}
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: CommandEntry) => (
                        <CommandItem
                          key={item.id}
                          onClick={item.action}
                          value={item.value}
                        >
                          <item.icon className="size-3.5 text-fg-3" />
                          <span
                            className={
                              item.mono ? "font-mono" : "min-w-0 truncate"
                            }
                          >
                            {item.label}
                          </span>
                          {item.hint ? (
                            <span className="ml-auto min-w-0 truncate font-mono text-micro text-fg-3">
                              {item.hint}
                            </span>
                          ) : null}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
