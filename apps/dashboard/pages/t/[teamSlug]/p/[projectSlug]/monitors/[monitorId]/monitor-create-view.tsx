import { MonTypeGlyph } from "@/components/monitors/monitor-status";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { Link } from "@/components/ui/link";
import { HttpMonitorForm } from "../http-monitor-form";
import { MonitorForm } from "../monitor-form";
import { TcpMonitorForm } from "../tcp-monitor-form";
import type { Props } from "./index.server";

type CreateProps = Extract<Props, { mode: "create" }>;

export function MonitorCreateView({ project, type, formError }: CreateProps) {
  const monitorsBase = `/t/${project.teamSlug}/p/${project.slug}/monitors`;
  const action = `${monitorsBase}/new?createMonitor`;
  const isHttp = type === "http";
  const isTcp = type === "tcp";
  const isBrowser = type === "browser";

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <DetailHeaderBar className="gap-1.5 border-b border-line-1">
        <HeaderCrumbs items={[{ label: "Monitors", href: monitorsBase }]} />
        <h1 className="text-heading font-semibold tracking-[-0.2px]">
          New monitor
        </h1>
      </DetailHeaderBar>
      <div className="shrink-0 border-b border-line-1 px-6 py-3">
        <p className="text-body text-fg-3">
          {isHttp
            ? "Check a URL on a schedule — status, response time, headers, and body."
            : isTcp
              ? "Check a host:port is reachable on a schedule — opens a raw TCP connection."
              : isBrowser
                ? "Author a Playwright test and pick how often it should run against production."
                : "Choose what to monitor."}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[860px] px-6 pt-6 pb-16">
          {isHttp ? (
            <HttpMonitorForm
              action={action}
              cancelHref={monitorsBase}
              error={formError}
              submitLabel="Create monitor"
            />
          ) : isTcp ? (
            <TcpMonitorForm
              action={action}
              cancelHref={monitorsBase}
              error={formError}
              submitLabel="Create monitor"
            />
          ) : isBrowser ? (
            <MonitorForm
              action={action}
              cancelHref={monitorsBase}
              error={formError}
              submitLabel="Create monitor"
            />
          ) : (
            <TypeChooser monitorsBase={monitorsBase} />
          )}
        </div>
      </div>
    </div>
  );
}

function TypeChooser({ monitorsBase }: { monitorsBase: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <TypeCard
        description="Run a Playwright test on a schedule — full browser flows like login or checkout, producing a run report."
        glyph="browser"
        href={`${monitorsBase}/new?type=browser`}
        title="Browser check"
      />
      <TypeCard
        description="Check a URL is up and fast — status code, response time, header and body assertions. No code."
        glyph="http"
        href={`${monitorsBase}/new?type=http`}
        title="Uptime check"
      />
      <TypeCard
        description="Check a host:port is reachable — a raw TCP connect for databases, SMTP, Redis, or anything that listens on a port."
        glyph="tcp"
        href={`${monitorsBase}/new?type=tcp`}
        title="TCP check"
      />
    </div>
  );
}

function TypeCard({
  href,
  glyph,
  title,
  description,
}: {
  href: string;
  glyph: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      className="group flex flex-col gap-2.5 rounded-[11px] border border-line-1 bg-bg-1 p-5 transition-colors hover:border-bg-3/50 hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
    >
      <span className="flex size-10 items-center justify-center rounded-[10px] border border-line-1 bg-bg-2 text-info">
        <MonTypeGlyph size={18} type={glyph} />
      </span>
      <span className="text-body-lg font-semibold">{title}</span>
      <span className="text-body leading-relaxed text-fg-3">{description}</span>
    </Link>
  );
}
