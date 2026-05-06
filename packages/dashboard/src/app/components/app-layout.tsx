import { Suspense } from "react";
import {
  ArrowLeft,
  BarChart2,
  Bell,
  CheckSquare,
  CircleHelp,
  FlaskConical,
  Plus,
  Settings,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { LayoutProps } from "rwsdk/router";
import { requestInfo } from "rwsdk/worker";
import { ProjectSwitcher } from "@/app/components/project-switcher";
import { QueryProvider } from "@/app/components/query-provider";
import { SidebarUserMenu } from "@/app/components/sidebar-user-menu";
import { Skeleton } from "@/app/components/ui/skeleton";
import { TeamSwitcher } from "@/app/components/team-switcher";
import { NuqsRwsdkAdapter } from "@/lib/nuqs-rwsdk-adapter";
import {
  getUserTeams,
  type ResolvedActiveProject,
  type ResolvedActiveTeam,
} from "@/lib/authz";
import { cn } from "@/lib/cn";
import { resolveDefaultLanding } from "@/lib/user-state";

type NavId = "runs" | "flaky" | "insights" | "tests";

function deriveActiveNav(pathname: string): NavId {
  if (/\/flaky(\/|$)/.test(pathname)) return "flaky";
  if (/\/insights(\/|$)/.test(pathname)) return "insights";
  if (/\/tests\//.test(pathname)) return "tests";
  return "runs";
}

type AppSidebarData = {
  teams: { slug: string; name: string }[];
  activeTeam: ResolvedActiveTeam | null;
  projects: { slug: string; name: string }[];
  activeProject: ResolvedActiveProject | null;
};

interface PreloadedTenant {
  userTeams: { slug: string; name: string }[];
  activeTeam: ResolvedActiveTeam | null;
  teamProjects: { slug: string; name: string }[];
  activeProject: ResolvedActiveProject | null;
}

// Sidebar data resolves entirely from ctx (populated by `loadActiveProject`
// middleware in one ControlDO RPC) — no DO calls happen here. Team
// suggestions used to be fetched in this function too, costing two more
// ControlDO RPCs on every render; they now stream in via their own
// Suspense boundary inside `AppSidebarContents`, so the rest of the
// sidebar paints as soon as ctx data is ready. Function stays async to
// fit the existing Suspense flow downstream.
async function fetchAppSidebarData(
  userId: string | null,
  preloaded: PreloadedTenant,
): Promise<AppSidebarData> {
  if (!userId) {
    return {
      teams: [],
      activeTeam: null,
      projects: [],
      activeProject: null,
    };
  }
  return {
    teams: preloaded.userTeams,
    activeTeam: preloaded.activeTeam,
    projects: preloaded.teamProjects,
    activeProject: preloaded.activeProject,
  };
}

export function AppLayout({ children }: LayoutProps): React.ReactElement {
  // Sync layout shell — nothing in the chrome awaits a DO. The sidebar and
  // ProjectSwitcher each have their own Suspense boundary so the page's
  // {children} can render in parallel with sidebar data fetching.
  const { ctx, request } = requestInfo;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const serverSearch = url.search;
  const mode: "app" | "settings" = pathname.startsWith("/settings")
    ? "settings"
    : "app";

  const userId = ctx.user?.id ?? null;

  // Kick off async data without awaiting; loaders await inside Suspense.
  // Same `appPromise` flows to sidebar + ProjectSwitcher so the underlying
  // ControlDO queries run once.
  const preloaded: PreloadedTenant = {
    userTeams: ctx.userTeams ?? [],
    activeTeam: ctx.activeTeam ?? null,
    teamProjects: ctx.teamProjects ?? [],
    activeProject: ctx.activeProject ?? null,
  };
  const appPromise: Promise<AppSidebarData> | null =
    mode === "app" ? fetchAppSidebarData(userId, preloaded) : null;
  const settingsTeamsPromise =
    mode === "settings" && userId
      ? getUserTeams(userId)
      : Promise.resolve([] as { slug: string; name: string }[]);

  return (
    <NuqsRwsdkAdapter serverSearch={serverSearch}>
      <QueryProvider>
        <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
          <nav className="fixed left-0 top-0 h-full w-64 flex flex-col border-r border-sidebar-border bg-sidebar z-50">
            {mode === "settings" ? (
              <Suspense fallback={<SettingsSidebarSkeleton />}>
                <SettingsSidebarLoader
                  pathname={pathname}
                  teamsPromise={settingsTeamsPromise}
                  userId={userId}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<AppSidebarSkeleton signedIn={!!userId} />}>
                <AppSidebarLoader
                  pathname={pathname}
                  appPromise={appPromise as Promise<AppSidebarData>}
                  signedIn={!!userId}
                />
              </Suspense>
            )}
          </nav>

          <main className="flex-1 ml-64 flex flex-col min-w-0 overflow-hidden">
            <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-background sticky top-0 z-40">
              {mode === "app" ? (
                <Suspense fallback={<ProjectSwitcherSkeleton />}>
                  <ProjectSwitcherLoader
                    appPromise={appPromise as Promise<AppSidebarData>}
                  />
                </Suspense>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Notifications"
                >
                  <Bell size={18} />
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Help"
                >
                  <CircleHelp size={18} />
                </button>
                {ctx.user && (
                  <SidebarUserMenu
                    name={ctx.user.name}
                    email={ctx.user.email}
                    image={ctx.user.image}
                  />
                )}
              </div>
            </header>

            <div className="flex-1 overflow-hidden flex flex-col min-h-0 overflow-y-auto">
              {children}
            </div>
          </main>
        </div>
      </QueryProvider>
    </NuqsRwsdkAdapter>
  );
}

async function AppSidebarLoader({
  pathname,
  appPromise,
  signedIn,
}: {
  pathname: string;
  appPromise: Promise<AppSidebarData>;
  signedIn: boolean;
}): Promise<React.ReactElement> {
  const app = await appPromise;
  return (
    <AppSidebarContents
      pathname={pathname}
      teams={app.teams}
      activeTeam={app.activeTeam}
      activeProject={app.activeProject}
      signedIn={signedIn}
    />
  );
}

async function SettingsSidebarLoader({
  pathname,
  teamsPromise,
  userId,
}: {
  pathname: string;
  teamsPromise: Promise<{ slug: string; name: string }[]>;
  userId: string | null;
}): Promise<React.ReactElement> {
  const [teams, landing] = await Promise.all([
    teamsPromise,
    userId ? resolveDefaultLanding(userId) : Promise.resolve(null),
  ]);
  // Skip the `/` redirect when we know where the user would land — keeps the
  // "Back to app" click on rwsdk's RSC navigation path. Falls back to `/`
  // only when the user has no teams (rare; the team picker handles that).
  const backToAppHref = landing
    ? landing.kind === "project"
      ? `/t/${landing.teamSlug}/p/${landing.projectSlug}`
      : `/t/${landing.teamSlug}`
    : "/";
  return (
    <SettingsSidebarContents
      pathname={pathname}
      teams={teams}
      backToAppHref={backToAppHref}
    />
  );
}

async function ProjectSwitcherLoader({
  appPromise,
}: {
  appPromise: Promise<AppSidebarData>;
}): Promise<React.ReactElement> {
  const app = await appPromise;
  if (!app.activeTeam || !app.activeProject) return <span />;
  return (
    <ProjectSwitcher
      teamSlug={app.activeTeam.slug}
      currentProjectSlug={app.activeProject.slug}
      currentProjectName={app.activeProject.name}
      projects={app.projects}
      isOwner={app.activeTeam.role === "owner"}
    />
  );
}

function AppSidebarSkeleton({
  signedIn,
}: {
  signedIn: boolean;
}): React.ReactElement {
  return (
    <>
      <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="flex-1 flex flex-col gap-1 px-2 pt-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={`nav-${i}`} className="h-9 w-full" />
        ))}
      </div>
      {signedIn ? (
        <div className="flex flex-col gap-0.5 px-2 pb-5 shrink-0">
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
    </>
  );
}

function SettingsSidebarSkeleton(): React.ReactElement {
  return (
    <>
      <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex-1 flex flex-col gap-3 px-2 pt-4">
        <Skeleton className="h-3 w-16 mx-3" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-3 w-20 mx-3 mt-2" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={`team-${i}`} className="h-9 w-full" />
        ))}
      </div>
    </>
  );
}

function ProjectSwitcherSkeleton(): React.ReactElement {
  return <Skeleton className="h-8 w-48" />;
}

interface AppSidebarContentsProps {
  pathname: string;
  teams: { slug: string; name: string }[];
  activeTeam: { slug: string; name: string } | null;
  activeProject: { slug: string; name: string } | null;
  signedIn: boolean;
}

function AppSidebarContents({
  pathname,
  teams,
  activeTeam,
  activeProject,
  signedIn,
}: AppSidebarContentsProps) {
  const activeNav = deriveActiveNav(pathname);
  const base =
    activeTeam && activeProject
      ? `/t/${activeTeam.slug}/p/${activeProject.slug}`
      : null;

  const navItems: {
    href: string;
    label: string;
    icon: typeof CheckSquare;
    id: NavId;
    disabled?: boolean;
  }[] = base
    ? [
        { href: base, label: "Runs", icon: CheckSquare, id: "runs" },
        {
          href: `${base}/flaky`,
          label: "Flaky Tests",
          icon: TriangleAlert,
          id: "flaky",
        },
        {
          href: `${base}/insights`,
          label: "Insights",
          icon: BarChart2,
          id: "insights",
        },
        {
          href: "#",
          label: "Tests",
          icon: FlaskConical,
          id: "tests",
          disabled: true,
        },
      ]
    : [];

  return (
    <>
      {activeTeam ? (
        <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
          <TeamSwitcher
            currentTeamSlug={activeTeam.slug}
            currentTeamName={activeTeam.name}
            teams={teams}
          />
        </div>
      ) : (
        <div className="h-14 px-4 shrink-0 flex items-center text-sm font-semibold tracking-tight border-b border-sidebar-border">
          Wrightful
        </div>
      )}

      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto">
        {navItems.map((item) => {
          const active = activeNav === item.id;
          return (
            <a
              key={item.id}
              href={item.disabled ? undefined : item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                  : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                item.disabled &&
                  "opacity-40 cursor-not-allowed pointer-events-none",
              )}
            >
              <item.icon size={16} />
              {item.label}
            </a>
          );
        })}
      </div>

      {signedIn ? (
        <div className="flex flex-col gap-0.5 px-2 pb-5 shrink-0">
          <a
            href="/settings/profile"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <Settings size={16} />
            Settings
          </a>
        </div>
      ) : null}
    </>
  );
}

interface SettingsSidebarContentsProps {
  pathname: string;
  teams: { slug: string; name: string }[];
  backToAppHref: string;
}

function SettingsSidebarContents({
  pathname,
  teams,
  backToAppHref,
}: SettingsSidebarContentsProps) {
  const profileActive = pathname.startsWith("/settings/profile");

  return (
    <>
      <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
        <a
          href={backToAppHref}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to app
        </a>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-2 overflow-y-auto">
        <div className="flex flex-col gap-0.5">
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Account
          </div>
          <a
            href="/settings/profile"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              profileActive
                ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            <UserRound size={16} />
            Profile
          </a>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Your teams
          </div>
          {teams.length === 0 ? (
            <p className="px-3 py-1 text-sidebar-foreground/50 text-xs">
              No teams yet.
            </p>
          ) : (
            teams.map((team) => {
              const href = `/settings/teams/${team.slug}`;
              const active =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <a
                  key={team.slug}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors min-w-0",
                    active
                      ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                      : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-sidebar-border bg-sidebar-accent font-mono font-semibold text-[10px] text-sidebar-foreground/70 uppercase">
                    {team.name.charAt(0)}
                  </span>
                  <span className="truncate">{team.name}</span>
                </a>
              );
            })
          )}
          <a
            href="/settings/teams/new"
            className={cn(
              "mt-1 flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              pathname === "/settings/teams/new"
                ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            <Plus size={16} />
            Create team
          </a>
        </div>
      </div>
    </>
  );
}
