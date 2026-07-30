import { use } from "react";
import { DANGER_TRIGGER_CLASSES } from "@/components/danger-trigger";
import { DeferredSection } from "@/components/defer-error-boundary";
import {
  MonBadge,
  MonGlyph,
  monitorDisplayStatus,
  MonTypeGlyph,
} from "@/components/monitors/monitor-status";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/time-format";
import { Bell, BellOff, Pause, Play, Settings } from "lucide-react";
import { AlertRecipientsFields } from "../alert-recipients-fields";
import { HttpMonitorForm } from "../http-monitor-form";
import { MonitorEditDialog } from "../monitor-edit-dialog";
import { MonitorForm } from "../monitor-form";
import { TcpMonitorForm } from "../tcp-monitor-form";
import { humanizeInterval, monitorTypeLabel } from "../monitors-ui.shared";
import type { Props } from "./index.server";
import { MonitorCreateView } from "./monitor-create-view";
import {
  AnalyticsAndExecutions,
  AnalyticsAndExecutionsSkeleton,
  HeaderUptime,
  HttpConfigSummary,
  TcpConfigSummary,
} from "./monitor-detail-content";

type DetailProps = Extract<Props, { mode: "detail" }>;

export default function MonitorPage(props: Props) {
  if (props.mode === "create") return <MonitorCreateView {...props} />;
  return <MonitorDetailView {...props} />;
}

function MonitorDetailView({
  project,
  monitor,
  httpConfig,
  tcpConfig,
  nextRunAt,
  editing,
  formError,
  dangerError,
  alertTargets,
  detail,
}: DetailProps) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const monitorsBase = `${base}/monitors`;
  const here = `${monitorsBase}/${monitor.id}`;
  const enabled = monitor.enabled === 1;
  const alertsOn = monitor.alertsEnabled === 1;
  const status = monitorDisplayStatus(monitor);
  const isHttp = monitor.type === "http";
  const isTcp = monitor.type === "tcp" || monitor.type === "ping";
  // Members get a read-only detail view; only owners can edit/pause/delete (the
  // actions are owner-gated server-side). ANDing `isOwner` here also defends
  // against a member hand-typing `?edit=1`: the edit modal is only rendered for
  // owners, so a non-owner cannot open it regardless of the URL flag.
  const isOwner = project.role === "owner";
  const editingOpen = isOwner && editing;
  const recipientsFields = (
    <DeferredSection skeleton={<RecipientsFieldsSkeleton />}>
      <RecipientsFieldsRegion
        alertTargets={alertTargets}
        detail={detail}
        teamSlug={project.teamSlug}
      />
    </DeferredSection>
  );
  const editSectionButton = isOwner ? (
    <Button render={<Link href={`${here}?edit=1`} />} size="xs" variant="ghost">
      <Settings className="size-[11px]" />
      Edit
    </Button>
  ) : null;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailHeaderBar className="gap-3 border-b border-line-1">
          <HeaderCrumbs items={[{ label: "Monitors", href: monitorsBase }]} />
          <h1
            className="flex min-w-0 items-center gap-2 text-heading font-semibold tracking-[-0.2px]"
            title={monitor.name}
          >
            <span className="min-w-0 max-w-[520px] truncate">
              {monitor.name}
            </span>
            <MonGlyph size={18} state={status} />
          </h1>
          <MonBadge state={status} />
          <div className="flex-1" />

          {isOwner && (
            <>
              <form
                action={`${here}?toggleEnabled`}
                className="m-0"
                method="post"
              >
                <input
                  name="enabled"
                  type="hidden"
                  value={enabled ? "false" : "true"}
                />
                <Button size="sm" type="submit" variant="outline">
                  {enabled ? (
                    <Pause className="size-3.5" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  {enabled ? "Pause" : "Resume"}
                </Button>
              </form>

              <form
                action={`${here}?toggleAlerts`}
                className="m-0"
                method="post"
              >
                <input
                  name="alertsEnabled"
                  type="hidden"
                  value={alertsOn ? "false" : "true"}
                />
                <Button size="sm" type="submit" variant="outline">
                  {alertsOn ? (
                    <BellOff className="size-3.5" />
                  ) : (
                    <Bell className="size-3.5" />
                  )}
                  {alertsOn ? "Mute alerts" : "Unmute alerts"}
                </Button>
              </form>

              <Button
                render={<Link href={`${here}?edit=1`} />}
                size="sm"
                variant="outline"
              >
                <Settings className="size-3.5" />
                Edit
              </Button>
            </>
          )}
        </DetailHeaderBar>

        <div className="flex flex-wrap items-stretch gap-y-2.5 border-b border-line-1 px-6 py-3">
          <MetaItem
            first
            label="Type"
            value={
              <span className="inline-flex items-center gap-1">
                <MonTypeGlyph size={11} type={monitor.type} />
                {monitorTypeLabel(monitor.type)}
              </span>
            }
          />
          <MetaItem
            label="Interval"
            value={
              <span className="font-mono">
                {humanizeInterval(monitor.intervalSeconds)}
              </span>
            }
          />
          <MetaItem label="State" value={enabled ? "Enabled" : "Paused"} />
          <MetaItem label="Alerts" value={alertsOn ? "On" : "Muted"} />
          <MetaItem
            label="Last run"
            value={
              monitor.lastRunAt ? formatRelativeTime(monitor.lastRunAt) : "—"
            }
          />
          <MetaItem
            label="Next run"
            value={
              enabled
                ? nextRunAt
                  ? formatRelativeTime(nextRunAt)
                  : "queued"
                : "paused"
            }
          />
          <MetaItem
            label="Uptime 24h"
            last
            value={
              <DeferredSection
                skeleton={
                  <Skeleton className="inline-block h-[15px] w-12 align-middle" />
                }
              >
                <HeaderUptime detail={detail} />
              </DeferredSection>
            }
          />
        </div>

        <div className="mx-auto flex max-w-[980px] flex-col gap-[18px] px-6 pt-5 pb-16">
          {isOwner && (
            <MonitorEditDialog closeHref={here} open={editingOpen}>
              {isHttp ? (
                <HttpMonitorForm
                  action={`${here}?updateMonitor`}
                  defaultConfig={httpConfig ?? undefined}
                  defaultEnabled={enabled}
                  defaultIntervalSeconds={monitor.intervalSeconds}
                  defaultName={monitor.name}
                  error={formError}
                  recipients={recipientsFields}
                  submitLabel="Save changes"
                />
              ) : isTcp ? (
                <TcpMonitorForm
                  action={`${here}?updateMonitor`}
                  defaultConfig={tcpConfig ?? undefined}
                  defaultEnabled={enabled}
                  defaultIntervalSeconds={monitor.intervalSeconds}
                  defaultName={monitor.name}
                  error={formError}
                  recipients={recipientsFields}
                  submitLabel="Save changes"
                />
              ) : (
                <MonitorForm
                  action={`${here}?updateMonitor`}
                  defaultEnabled={enabled}
                  defaultIntervalSeconds={monitor.intervalSeconds}
                  defaultName={monitor.name}
                  defaultSource={monitor.source ?? ""}
                  error={formError}
                  recipients={recipientsFields}
                  submitLabel="Save changes"
                />
              )}
            </MonitorEditDialog>
          )}

          <DeferredSection
            skeleton={<AnalyticsAndExecutionsSkeleton isHttp={isHttp} />}
          >
            <AnalyticsAndExecutions
              base={base}
              detail={detail}
              enabled={enabled}
              isHttp={isHttp}
              isTcp={isTcp}
            />
          </DeferredSection>

          {isHttp ? (
            <section>
              <SectionTitle right={editSectionButton} title="Request" />
              <HttpConfigSummary config={httpConfig} />
            </section>
          ) : isTcp ? (
            <section>
              <SectionTitle right={editSectionButton} title="Connection" />
              <TcpConfigSummary config={tcpConfig} />
            </section>
          ) : (
            <section>
              <SectionTitle right={editSectionButton} title="Test definition" />
              <CodeEditor
                aria-label="Monitor test definition"
                height={220}
                onValueChange={NOOP}
                readOnly
                value={monitor.source ?? ""}
              />
            </section>
          )}

          {isOwner && (
            <section className="mt-2 overflow-hidden rounded-[9px] border border-fail/30 bg-bg-1">
              <div className="border-b border-fail/20 bg-fail-soft px-[18px] py-3">
                <h3 className="text-body font-semibold text-fail">
                  Danger zone
                </h3>
              </div>
              <div className="flex items-center gap-4 px-[18px] py-4">
                <div className="flex-1">
                  <div className="text-body font-medium">Delete monitor</div>
                  <p className="mt-1 text-caption leading-relaxed text-fg-3">
                    Stops the schedule and removes this monitor.
                    {!isHttp &&
                      !isTcp &&
                      " Run reports it already produced are retained."}
                  </p>
                </div>
                <details className="group shrink-0">
                  <summary className={cn(DANGER_TRIGGER_CLASSES, "self-auto")}>
                    Delete monitor
                  </summary>
                  <form
                    action={`${here}?deleteMonitor`}
                    className="mt-3 flex flex-col items-end gap-3"
                    method="post"
                  >
                    {dangerError && (
                      <Alert variant="error">
                        <AlertDescription>{dangerError}</AlertDescription>
                      </Alert>
                    )}
                    <Button size="sm" type="submit" variant="destructive">
                      Permanently delete
                    </Button>
                  </form>
                </details>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function RecipientsFieldsRegion({
  detail,
  alertTargets,
  teamSlug,
}: {
  detail: DetailProps["detail"];
  alertTargets: DetailProps["alertTargets"];
  teamSlug: string;
}) {
  const { members, groups } = use(detail);
  return (
    <AlertRecipientsFields
      alertTargets={alertTargets}
      groups={groups}
      members={members}
      teamSlug={teamSlug}
    />
  );
}

function RecipientsFieldsSkeleton() {
  return (
    <div className="border-t border-line-1 pt-4">
      <Skeleton className="mb-1 h-[15px] w-28" />
      <Skeleton className="mb-3.5 h-[15px] w-64" />
      <div className="mb-4 flex flex-col gap-1.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-52" />
      </div>
      <Skeleton className="mb-1.5 h-[13px] w-20" />
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton className="h-4 w-56" key={index} />
        ))}
      </div>
    </div>
  );
}

function NOOP() {}

function MetaItem({
  label,
  value,
  first,
  last,
}: {
  label: string;
  value: React.ReactNode;
  first?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-[3px] px-4",
        first && "pl-0",
        !last && "border-r border-r-line-1",
      )}
    >
      <span className="whitespace-nowrap text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </span>
      <span className="whitespace-nowrap text-body text-fg-1">{value}</span>
    </div>
  );
}

function SectionTitle({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h3 className="text-body-lg font-semibold">{title}</h3>
      {right}
    </div>
  );
}
