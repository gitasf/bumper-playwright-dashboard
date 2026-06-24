import {
  ArrowLeft,
  BarChart2,
  CheckSquare,
  CreditCard,
  FileClock,
  FlaskConical,
  Gauge,
  KeyRound,
  List,
  Radar,
  Settings,
  TriangleAlert,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import { useState } from "react";
import { Link, useRouter, useShared } from "@void/react";
import { CommandMenu, useCommandMenuShortcut } from "@/components/command-menu";
import { QueryProvider } from "@/components/query-provider";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { cn } from "@/lib/cn";
import type {
  ResolvedActiveProject,
  ResolvedActiveTeam,
  WorkspaceListItem,
} from "@/lib/shared-bundle";

type NavId = "runs" | "monitors" | "flaky" | "insights" | "tests";

function deriveActiveNav(pathname: string): NavId {
  if (/\/monitors(\/|$)/.test(pathname)) return "monitors";
  if (/\/flaky(\/|$)/.test(pathname)) return "flaky";
  if (/\/insights(\/|$)/.test(pathname)) return "insights";
  if (/\/tests(\/|$)/.test(pathname)) return "tests";
  return "runs";
}

function buildBackToAppHref(
  selectedTeam: ResolvedActiveTeam | null,
  selectedProject: ResolvedActiveProject | null,
): string {
  if (selectedTeam && selectedProject) {
    return `/t/${selectedTeam.slug}/p/${selectedProject.slug}`;
  }
  if (selectedTeam) return `/t/${selectedTeam.slug}`;
  return "/";
}

interface AppLayoutProps {
  children: React.ReactNode;
  /**
   * Settings mode swaps the middle nav for the account/teams chrome. The
   * route layouts pass this explicitly: `pages/settings/layout.tsx` sets
   * `"settings"`, `pages/t/[teamSlug]/p/[projectSlug]/layout.tsx` sets `"app"`.
   */
  mode: "app" | "settings";
}

/**
 * Top-level app shell: 240px integrated sidebar (no top header).
 *
 * Shared chrome across both modes:
 * - Top: `<WorkspaceSwitcher>` when a workspace is selected; "Wrightful"
 *   placeholder otherwise.
 * - Bottom (above user menu): Settings link (app mode) or "Back to app" link
 *   (settings mode).
 *
 * Selection comes from `useShared()` → `selectedTeam` / `selectedProject`,
 * populated by `middleware/01.context.ts` from the `wf_workspace` cookie
 * (URL overrides cookie when pinned).
 */
export function AppLayout({ children, mode }: AppLayoutProps) {
  const router = useRouter();
  const {
    auth,
    userTeams,
    selectedTeam,
    teamProjects,
    selectedProject,
    billingEnabled,
  } = useShared();
  const pathname = router.path;
  const user = auth?.user ?? null;

  const [cmdOpen, setCmdOpen] = useState(false);
  useCommandMenuShortcut(setCmdOpen);

  return (
    <QueryProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
        <nav className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
          <SidebarTop
            selectedProject={selectedProject}
            selectedTeam={selectedTeam}
            teamProjects={teamProjects}
            teams={userTeams}
          />

          {mode === "settings" ? (
            <SettingsSidebarMiddle
              billingEnabled={billingEnabled}
              pathname={pathname}
              selectedProject={selectedProject}
              selectedTeam={selectedTeam}
              teams={userTeams}
            />
          ) : (
            <AppSidebarMiddle
              base={
                selectedTeam && selectedProject
                  ? `/t/${selectedTeam.slug}/p/${selectedProject.slug}`
                  : null
              }
              pathname={pathname}
            />
          )}

          <SidebarBottom
            mode={mode}
            selectedProject={selectedProject}
            selectedTeam={selectedTeam}
          />

          {user && (
            <div className="shrink-0 border-t border-sidebar-border p-2">
              <SidebarUserMenu
                email={user.email}
                image={user.image}
                name={user.name}
              />
            </div>
          )}
        </nav>

        <main className="flex flex-1 min-w-0 flex-col overflow-hidden">
          {children}
        </main>
      </div>

      <CommandMenu
        activeProject={selectedProject}
        activeTeam={selectedTeam}
        onOpenChange={setCmdOpen}
        open={cmdOpen}
        projects={teamProjects}
        teams={userTeams}
      />
    </QueryProvider>
  );
}

interface SidebarTopProps {
  teams: WorkspaceListItem[];
  teamProjects: WorkspaceListItem[];
  selectedTeam: ResolvedActiveTeam | null;
  selectedProject: ResolvedActiveProject | null;
}

function SidebarTop({
  teams,
  teamProjects,
  selectedTeam,
  selectedProject,
}: SidebarTopProps) {
  return (
    <div className="shrink-0 px-2 pb-1.5 pt-2.5">
      {selectedTeam && selectedProject ? (
        <WorkspaceSwitcher
          isOwner={selectedTeam.role === "owner"}
          projects={teamProjects}
          selectedProject={selectedProject}
          selectedTeam={selectedTeam}
          teams={teams}
        />
      ) : (
        <div className="flex h-9 items-center px-2 text-sm font-semibold tracking-tight">
          Wrightful
        </div>
      )}
    </div>
  );
}

interface SidebarBottomProps {
  mode: "app" | "settings";
  selectedTeam: ResolvedActiveTeam | null;
  selectedProject: ResolvedActiveProject | null;
}

function SidebarBottom({
  mode,
  selectedTeam,
  selectedProject,
}: SidebarBottomProps) {
  if (mode === "settings") {
    const href = buildBackToAppHref(selectedTeam, selectedProject);
    return (
      <div className="shrink-0 px-2 pb-2">
        <Link
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
            "text-sidebar-foreground hover:bg-accent hover:text-foreground",
          )}
          href={href}
        >
          <ArrowLeft className="size-4" />
          Back to app
        </Link>
      </div>
    );
  }
  return (
    <div className="shrink-0 px-2 pb-2">
      <Link
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          "text-sidebar-foreground hover:bg-accent hover:text-foreground",
        )}
        href="/settings/profile"
      >
        <Settings className="size-4" />
        Settings
      </Link>
    </div>
  );
}

interface AppSidebarMiddleProps {
  pathname: string;
  base: string | null;
}

function AppSidebarMiddle({ pathname, base }: AppSidebarMiddleProps) {
  const activeNav = deriveActiveNav(pathname);
  const navItems: {
    href: string;
    label: string;
    icon: typeof CheckSquare;
    id: NavId;
    count?: number;
  }[] = base
    ? [
        { href: base, label: "Runs", icon: CheckSquare, id: "runs" },
        {
          href: `${base}/monitors`,
          label: "Monitors",
          icon: Radar,
          id: "monitors",
        },
        {
          href: `${base}/flaky`,
          label: "Flaky tests",
          icon: TriangleAlert,
          id: "flaky",
        },
        {
          href: `${base}/tests`,
          label: "Tests",
          icon: FlaskConical,
          id: "tests",
        },
        {
          href: `${base}/insights`,
          label: "Insights",
          icon: BarChart2,
          id: "insights",
        },
      ]
    : [];

  return (
    <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
      {navItems.map((item) => {
        const active = activeNav === item.id;
        return (
          <Link
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active
                ? "bg-accent font-medium text-foreground"
                : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
            )}
            href={item.href}
            key={item.id}
          >
            <item.icon className="size-4" />
            <span className="flex-1">{item.label}</span>
            {item.count != null && (
              <span className="rounded-full bg-flaky-soft px-1.5 py-px font-mono text-[10.5px] font-semibold text-flaky tabular-nums">
                {item.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

interface SettingsSidebarMiddleProps {
  billingEnabled: boolean;
  pathname: string;
  teams: WorkspaceListItem[];
  selectedTeam: ResolvedActiveTeam | null;
  selectedProject: ResolvedActiveProject | null;
}

/**
 * Which team's settings group to expand in the sidebar. URL is the override
 * — when on `/settings/teams/<slug>/…` we expand that team regardless of the
 * workspace selection. Otherwise we fall back to the cookie-backed
 * `selectedTeam`, so the group stays expanded while you're on `/settings/profile`
 * or any other non-team-pinned settings page.
 */
const SETTINGS_TEAM_RE = /^\/settings\/teams\/([^/]+)(?:\/p\/([^/]+))?(?:\/|$)/;

function SettingsSidebarMiddle({
  billingEnabled,
  pathname,
  teams,
  selectedTeam,
  selectedProject,
}: SettingsSidebarMiddleProps) {
  const profileActive = pathname.startsWith("/settings/profile");

  const teamMatch = pathname.match(SETTINGS_TEAM_RE);
  const urlTeamSlug = teamMatch?.[1] ?? null;
  const urlProjectSlug = teamMatch?.[2] ?? null;

  const expandedTeam: WorkspaceListItem | null = urlTeamSlug
    ? (teams.find((t) => t.slug === urlTeamSlug) ?? {
        slug: urlTeamSlug,
        name: urlTeamSlug,
      })
    : selectedTeam;
  const expandedProject: WorkspaceListItem | null = urlProjectSlug
    ? { slug: urlProjectSlug, name: urlProjectSlug }
    : expandedTeam && selectedTeam?.slug === expandedTeam.slug
      ? selectedProject
      : null;

  // Owner-only nav entries (the audit log) only render when we can confirm the
  // expanded team is the selected one AND the viewer owns it. The page itself
  // 404s for non-owners regardless; this just avoids dangling a link a member
  // can't open. When the expanded team came from the URL (not the selected
  // workspace) we can't see its role, so we conservatively hide it.
  const isExpandedTeamOwner =
    !!expandedTeam &&
    selectedTeam?.slug === expandedTeam.slug &&
    selectedTeam.role === "owner";

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-1">
      <div className="flex flex-col gap-0.5">
        <SettingsSectionLabel>Account</SettingsSectionLabel>
        <SettingsNavLink
          active={profileActive}
          href="/settings/profile"
          icon={UserRound}
          label="Profile"
        />
      </div>

      {expandedTeam && (
        <div className="flex flex-col gap-0.5">
          <SettingsSectionLabel title={expandedTeam.name}>
            {expandedTeam.name}
          </SettingsSectionLabel>
          <SettingsNavLink
            active={
              pathname === `/settings/teams/${expandedTeam.slug}/general` ||
              pathname === `/settings/teams/${expandedTeam.slug}`
            }
            href={`/settings/teams/${expandedTeam.slug}/general`}
            icon={Settings}
            label="General"
          />
          <SettingsNavLink
            active={pathname === `/settings/teams/${expandedTeam.slug}/members`}
            href={`/settings/teams/${expandedTeam.slug}/members`}
            icon={Users}
            label="Members"
          />
          <SettingsNavLink
            active={pathname === `/settings/teams/${expandedTeam.slug}/groups`}
            href={`/settings/teams/${expandedTeam.slug}/groups`}
            icon={UsersRound}
            label="Groups"
          />
          <SettingsNavLink
            active={pathname === `/settings/teams/${expandedTeam.slug}/usage`}
            href={`/settings/teams/${expandedTeam.slug}/usage`}
            icon={Gauge}
            label="Usage"
          />
          <SettingsNavLink
            active={
              pathname.startsWith(
                `/settings/teams/${expandedTeam.slug}/projects`,
              ) ||
              (pathname.startsWith(`/settings/teams/${expandedTeam.slug}/p/`) &&
                !urlProjectSlug)
            }
            href={`/settings/teams/${expandedTeam.slug}/projects`}
            icon={List}
            label="Projects"
          />
          {isExpandedTeamOwner && (
            <SettingsNavLink
              active={pathname === `/settings/teams/${expandedTeam.slug}/audit`}
              href={`/settings/teams/${expandedTeam.slug}/audit`}
              icon={FileClock}
              label="Audit log"
            />
          )}
          {isExpandedTeamOwner && billingEnabled && (
            <SettingsNavLink
              active={
                pathname === `/settings/teams/${expandedTeam.slug}/billing`
              }
              href={`/settings/teams/${expandedTeam.slug}/billing`}
              icon={CreditCard}
              label="Billing"
            />
          )}
        </div>
      )}

      {expandedTeam && expandedProject && (
        <div className="flex flex-col gap-0.5">
          <SettingsSectionLabel title={expandedProject.name}>
            {expandedProject.name}
          </SettingsSectionLabel>
          <SettingsNavLink
            active={pathname.endsWith("/keys")}
            href={`/settings/teams/${expandedTeam.slug}/p/${expandedProject.slug}/keys`}
            icon={KeyRound}
            label="API keys"
          />
        </div>
      )}
    </div>
  );
}

function SettingsNavLink({
  active,
  href,
  icon: Icon,
  label,
}: {
  active: boolean;
  href: string;
  icon: typeof Settings;
  label: string;
}) {
  return (
    <Link
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
      )}
      href={href}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

function SettingsSectionLabel({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div
      className="truncate px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
      title={title}
    >
      {children}
    </div>
  );
}
