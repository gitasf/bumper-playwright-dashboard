import { Activity, ExternalLink, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { META_PILL_CLASSES } from "@/components/run/meta-pills";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Link } from "@/components/ui/link";
import { ExecStrip, MonGlyph } from "@/components/monitors/monitor-status";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DEFAULT_MONITOR_SPEC } from "./monitors-ui.shared";
import { MonitorsList } from "./monitors-list.client";
import type { Props } from "./index.server";

/**
 * Monitors list page. A synthetic monitor is a user-authored Playwright spec
 * run on a schedule; this is the project-scoped roster. The page is the server
 * shell: it renders the `PageHeader` and either the rich first-run onboarding
 * (no monitors) or the interactive `<MonitorsList>` island (summary strip +
 * filter/search + table with per-row pause toggle). Rows deep-link to the
 * monitor detail; the header / empty-state CTAs point at `./monitors/new`.
 */
export default function MonitorsListPage({ project, monitors }: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const monitorsBase = `${base}/monitors`;
  // Authoring monitors is owner-only (see the action gate + `index.server.ts`);
  // members get a read-only roster, so hide every create/toggle affordance.
  const isOwner = project.role === "owner";

  if (monitors.length === 0) {
    return (
      <>
        <PageHeader title="Monitors" />
        <MonitorsEmpty isOwner={isOwner} monitorsBase={monitorsBase} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        right={
          isOwner ? (
            <Button render={<Link href={`${monitorsBase}/new`} />} size="sm">
              <Plus className="size-4" />
              New monitor
            </Button>
          ) : undefined
        }
        title="Monitors"
      />

      <MonitorsList
        isOwner={isOwner}
        monitors={monitors}
        monitorsBase={monitorsBase}
        projectId={project.id}
      />
    </>
  );
}

/**
 * First-run onboarding for a project with no monitors. Centered explainer +
 * primary CTA, then a "what a monitor looks like" sample card showing the
 * default spec so the value prop is concrete before the user clicks create.
 */
function MonitorsEmpty({
  monitorsBase,
  isOwner,
}: {
  monitorsBase: string;
  isOwner: boolean;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <Empty className="justify-start py-12 md:py-12">
        <EmptyHeader className="max-w-[520px]">
          <EmptyMedia variant="icon">
            <Activity className="text-info" />
          </EmptyMedia>
          <EmptyTitle>
            Monitor production with the tests you already write
          </EmptyTitle>
          <EmptyDescription className="text-body-lg leading-relaxed">
            A monitor runs a Playwright test on a schedule against your live app
            — so you find out that login or checkout is broken{" "}
            <em>before a customer does</em>. Each run lands as a normal
            Wrightful run report.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-[680px]">
          <div className="flex gap-2">
            {isOwner && (
              <Button render={<Link href={`${monitorsBase}/new`} />} size="lg">
                <Plus className="size-4" />
                Create your first monitor
              </Button>
            )}
            <Button
              render={
                <a
                  href="https://playwright.dev/docs/intro"
                  rel="noreferrer"
                  target="_blank"
                />
              }
              size="lg"
              variant="outline"
            >
              <ExternalLink className="size-3.5" />
              Read the guide
            </Button>
          </div>

          {/* Sample */}
          <div className="mt-3 w-full text-left">
            <div className="mb-2 text-caption font-medium tracking-[0.1px] text-fg-3">
              What a monitor looks like
            </div>
            <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
              <div className="flex items-center gap-2.5 border-b border-line-1 px-4 py-3">
                <MonGlyph size={14} state="pass" />
                <span className="text-body-lg font-medium">
                  Checkout — reach payment
                </span>
                <span className={cn(META_PILL_CLASSES, "gap-1")}>browser</span>
                <span className="font-mono text-caption text-fg-3">
                  every 5m
                </span>
                <div className="flex-1" />
                <ExecStrip
                  count={12}
                  executions={SAMPLE_EXECUTIONS}
                  height={20}
                  width={96}
                />
              </div>
              <pre className="m-0 overflow-x-auto px-4 py-3.5 font-mono text-caption leading-relaxed text-fg-1">
                {DEFAULT_MONITOR_SPEC}
              </pre>
            </div>
          </div>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/** A made-up history for the onboarding sample card's `ExecStrip`. */
const SAMPLE_EXECUTIONS: ReadonlyArray<{ state: string }> = [
  { state: "pass" },
  { state: "pass" },
  { state: "degraded" },
  { state: "pass" },
  { state: "pass" },
  { state: "pass" },
  { state: "fail" },
  { state: "pass" },
  { state: "pass" },
  { state: "pass" },
  { state: "pass" },
  { state: "pass" },
];
