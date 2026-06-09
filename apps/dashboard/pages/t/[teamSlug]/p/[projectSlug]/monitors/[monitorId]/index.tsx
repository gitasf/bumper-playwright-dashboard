import { ArrowRight, Beaker, Clock, Pause, Play, Settings } from "lucide-react";
import { Link } from "@void/react";
import {
  MonBadge,
  MonGlyph,
  monitorDisplayStatus,
} from "@/components/monitors/monitor-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { cn } from "@/lib/cn";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { MonitorExecution } from "@schema";
import { MonitorForm } from "../monitor-form";
import { humanizeInterval } from "../monitors-ui.shared";
import type { Props } from "./index.server";

type CreateProps = Extract<Props, { mode: "create" }>;
type DetailProps = Extract<Props, { mode: "detail" }>;

/**
 * Serves two surfaces from one route (see `index.server.ts` — Void's matcher
 * has no static-over-dynamic precedence for nested-dynamic routes, so
 * `/monitors/new` resolves here as the `"new"` sentinel rather than a sibling
 * page). `mode === "create"` renders the new-monitor form; otherwise the
 * monitor detail.
 */
export default function MonitorPage(props: Props) {
  if (props.mode === "create") return <MonitorCreateView {...props} />;
  return <MonitorDetailView {...props} />;
}

/** New-monitor form. Posts to the `createMonitor` action on this same route. */
function MonitorCreateView({ project, formError }: CreateProps) {
  const monitorsBase = `/t/${project.teamSlug}/p/${project.slug}/monitors`;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-line-1 px-6 pt-4 pb-4">
        <Breadcrumb>
          <BreadcrumbList className="text-[12px]">
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link href={monitorsBase} />}>
                Monitors
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>New monitor</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="mt-2.5 text-[19px] font-semibold tracking-[-0.2px]">
          New monitor
        </h1>
        <p className="mt-1 text-[12.5px] text-fg-3">
          Author a Playwright test and pick how often it should run against
          production.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto max-w-[860px] px-6 pt-6 pb-16">
          <MonitorForm
            action={`${monitorsBase}/new?createMonitor`}
            cancelHref={monitorsBase}
            error={formError}
            submitLabel="Create monitor"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Monitor detail. Breadcrumbs + a header (status glyph, name, status badge,
 * Pause/Resume + Edit), then a meta row (Type / Interval / State / Last run /
 * Next run / Uptime 24h), the execution timeline (newest first, each browser
 * execution deep-linking into the existing rich run view), a read-only test
 * definition, the inline edit form (toggled via `?edit=1`), and a danger zone.
 */
function MonitorDetailView({
  project,
  monitor,
  executions,
  uptime,
  nextRunAt,
  editing,
  formError,
  dangerError,
}: DetailProps) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const monitorsBase = `${base}/monitors`;
  const here = `${monitorsBase}/${monitor.id}`;
  const enabled = monitor.enabled === 1;
  const status = monitorDisplayStatus(monitor);
  // Members get a read-only detail view; only owners can edit/pause/delete (the
  // actions are owner-gated server-side). `editingOpen` also defends against a
  // member hand-typing `?edit=1`: the edit section stays hidden AND the
  // read-only definition still shows (it keys off `!editingOpen`, not `!editing`).
  const isOwner = project.role === "owner";
  const editingOpen = isOwner && editing;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Header */}
        <header className="border-b border-line-1 px-6 pt-4 pb-4">
          <Breadcrumb>
            <BreadcrumbList className="text-[12px]">
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link href={monitorsBase} />}>
                  Monitors
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="max-w-[420px] truncate">
                  {monitor.name}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <div className="mt-2.5 flex items-center gap-3">
            <MonGlyph size={18} state={status} />
            <h1
              className="min-w-0 max-w-[520px] truncate text-[19px] font-semibold tracking-[-0.2px]"
              title={monitor.name}
            >
              {monitor.name}
            </h1>
            <MonBadge state={status} />
            <div className="flex-1" />

            {isOwner && (
              <>
                {/* Pause / resume — POSTs the desired next state. */}
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

                {/* Edit toggle — flips `?edit=1` (server-rendered, no island). */}
                <Button
                  render={<Link href={editing ? here : `${here}?edit=1`} />}
                  size="sm"
                  variant="outline"
                >
                  <Settings className="size-3.5" />
                  {editing ? "Close editor" : "Edit"}
                </Button>
              </>
            )}
          </div>

          {/* Meta row */}
          <div className="mt-3.5 flex flex-wrap items-stretch gap-y-2.5">
            <MetaItem
              first
              label="Type"
              value={
                <span className="inline-flex items-center gap-1">
                  <Beaker className="size-[11px] text-fg-3" />
                  {monitor.type}
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
                uptime != null ? (
                  <span
                    className={cn(
                      uptime > 99
                        ? "text-pass"
                        : uptime > 95
                          ? "text-degraded"
                          : "text-fail",
                    )}
                  >
                    {uptime.toFixed(1)}%
                  </span>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </header>

        <div className="mx-auto flex max-w-[980px] flex-col gap-[18px] px-6 pt-5 pb-16">
          {/* Edit section. */}
          {editingOpen && (
            <section className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
              <div className="border-b border-line-1 px-[18px] py-3">
                <h3 className="text-[13.5px] font-semibold">Edit monitor</h3>
                <p className="mt-0.5 text-[12px] text-fg-3">
                  Changes take effect on the next scheduled run.
                </p>
              </div>
              <div className="px-[18px] py-4">
                <MonitorForm
                  action={`${here}?updateMonitor`}
                  cancelHref={here}
                  defaultEnabled={enabled}
                  defaultIntervalSeconds={monitor.intervalSeconds}
                  defaultName={monitor.name}
                  defaultSource={monitor.source ?? ""}
                  error={formError}
                  submitLabel="Save changes"
                />
              </div>
            </section>
          )}

          {/* Execution timeline. */}
          <section>
            <SectionTitle
              right={
                executions.length > 0 ? (
                  <span className="text-[11.5px] text-fg-3">
                    {executions.length} recent · newest first
                  </span>
                ) : null
              }
              title="Executions"
            />
            <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
              {executions.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <div className="mb-2.5 inline-flex size-10 items-center justify-center rounded-[10px] border border-line-1 bg-bg-2 text-fg-3">
                    <Clock className="size-[18px]" />
                  </div>
                  <div className="text-[14px] font-medium">
                    No executions yet
                  </div>
                  <div className="mx-auto mt-1 max-w-[360px] text-[12.5px] leading-relaxed text-fg-3">
                    {enabled
                      ? "The first execution will appear here once the scheduler picks this monitor up — usually within a minute."
                      : "This monitor is paused. Resume it to start collecting executions."}
                  </div>
                </div>
              ) : (
                executions.map((ex, i) => (
                  <ExecRow
                    base={base}
                    exec={ex}
                    key={ex.id}
                    last={i === executions.length - 1}
                  />
                ))
              )}
            </div>
          </section>

          {/* Test definition (read-only when not editing). */}
          {!editingOpen && (
            <section>
              <SectionTitle
                right={
                  isOwner ? (
                    <Button
                      render={<Link href={`${here}?edit=1`} />}
                      size="xs"
                      variant="ghost"
                    >
                      <Settings className="size-[11px]" />
                      Edit
                    </Button>
                  ) : null
                }
                title="Test definition"
              />
              <CodeEditor
                aria-label="Monitor test definition"
                height={220}
                onValueChange={NOOP}
                readOnly
                value={monitor.source ?? ""}
              />
            </section>
          )}

          {/* Danger zone (owner-only). */}
          {isOwner && (
            <section className="mt-2 overflow-hidden rounded-[9px] border border-fail/30 bg-bg-1">
              <div className="border-b border-fail/20 bg-fail-soft px-[18px] py-3">
                <h3 className="text-[13px] font-semibold text-fail">
                  Danger zone
                </h3>
              </div>
              <div className="flex items-center gap-4 px-[18px] py-4">
                <div className="flex-1">
                  <div className="text-[13px] font-medium">Delete monitor</div>
                  <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
                    Stops the schedule and removes this monitor. Run reports it
                    already produced are retained.
                  </p>
                </div>
                <details className="group shrink-0">
                  <summary className="inline-flex h-[30px] cursor-pointer list-none items-center justify-center rounded-[5px] border border-fail/30 bg-fail-soft px-[11px] text-[13px] font-medium text-fail transition-colors hover:bg-fail/20 [&::-webkit-details-marker]:hidden">
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

/** No-op change handler for the read-only definition editor. */
function NOOP() {}

/** A description line for an execution, keyed off its terminal state. */
function execDescription(state: string): React.ReactNode {
  switch (state) {
    case "running":
      return <span className="text-running">running now…</span>;
    case "error":
      return (
        <span className="text-fg-3">
          infrastructure error — check could not run
        </span>
      );
    case "fail":
      return <span className="text-fg-3">assertion failed</span>;
    case "degraded":
      return (
        <span className="text-fg-3">completed slowly (soft assertion)</span>
      );
    default:
      return <span className="text-fg-3">completed</span>;
  }
}

/** One execution row in the timeline. */
function ExecRow({
  exec,
  base,
  last,
}: {
  exec: MonitorExecution;
  base: string;
  last: boolean;
}) {
  const isRunning = exec.state === "running";

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-l-2 px-[18px] py-[11px] transition-colors hover:bg-bg-2",
        last ? "border-b-0" : "border-b border-b-line-1",
        // A left accent rail flags the states that need attention; everything
        // else stays flush (transparent rail).
        exec.state === "fail"
          ? "border-l-fail"
          : exec.state === "error"
            ? "border-l-error"
            : "border-l-transparent",
      )}
    >
      <MonGlyph size={14} state={exec.state} />
      <div className="w-[92px] shrink-0">
        <MonBadge size="sm" state={exec.state} />
      </div>
      <div className="min-w-0 flex-1 text-[12.5px] text-fg-2">
        {execDescription(exec.state)}
      </div>
      <span className="w-[70px] text-right font-mono text-[11.5px] tabular-nums text-fg-3">
        {exec.durationMs != null ? formatDuration(exec.durationMs) : "—"}
      </span>
      <span className="w-[96px] text-right text-[12px]">
        {isRunning ? (
          <span className="text-running">now</span>
        ) : (
          <span className="text-fg-2">
            {formatRelativeTime(exec.createdAt)}
          </span>
        )}
      </span>
      <div className="flex w-[92px] justify-end">
        {exec.runId ? (
          <Button
            render={<Link href={`${base}/runs/${exec.runId}`} />}
            size="xs"
            variant="ghost"
          >
            View run
            <ArrowRight className="size-[11px]" />
          </Button>
        ) : (
          <span className="text-[11.5px] text-fg-4">
            {isRunning ? "in progress" : "no report"}
          </span>
        )}
      </div>
    </div>
  );
}

/** A meta cell in the header's stat row, divider on the right unless `last`. */
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
      <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.4px] text-fg-3">
        {label}
      </span>
      <span className="whitespace-nowrap text-[12.5px] text-fg-1">{value}</span>
    </div>
  );
}

/** Section heading: a 13.5px title with an optional right-aligned slot. */
function SectionTitle({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h3 className="text-[13.5px] font-semibold">{title}</h3>
      {right}
    </div>
  );
}
