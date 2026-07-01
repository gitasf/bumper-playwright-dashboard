import {
  ArrowRight,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Clock,
  Pause,
  Play,
  Settings,
  X as XIcon,
} from "lucide-react";
import { Link } from "@void/react";
import {
  AnalyticsLineChart,
  type LineChartBucket,
  type LineChartSeries,
} from "@/components/analytics/line-chart";
import {
  MonBadge,
  MonGlyph,
  monitorDisplayStatus,
  MonTypeGlyph,
} from "@/components/monitors/monitor-status";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { CodeEditor } from "@/components/ui/code-editor";
import { cn } from "@/lib/cn";
import {
  parseHttpResultDetail,
  parseTcpResultDetail,
} from "@/lib/monitors/monitor-schemas";
import type { HttpResultDetail, TcpResultDetail } from "@/lib/monitors/types";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { MonitorExecution } from "@schema";
import { HttpMonitorForm } from "../http-monitor-form";
import { MonitorForm } from "../monitor-form";
import { TcpMonitorForm } from "../tcp-monitor-form";
import { humanizeInterval, monitorTypeLabel } from "../monitors-ui.shared";
import type { Props } from "./index.server";

type CreateProps = Extract<Props, { mode: "create" }>;
type DetailProps = Extract<Props, { mode: "detail" }>;

/**
 * Serves two surfaces from one route (see `index.server.ts` — Void's matcher
 * has no static-over-dynamic precedence for nested-dynamic routes, so
 * `/monitors/new` resolves here as the `"new"` sentinel rather than a sibling
 * page). `mode === "create"` renders the new-monitor flow (type chooser →
 * per-type form); otherwise the monitor detail.
 */
export default function MonitorPage(props: Props) {
  if (props.mode === "create") return <MonitorCreateView {...props} />;
  return <MonitorDetailView {...props} />;
}

/**
 * New-monitor flow. With no `?type=`, shows the type chooser (browser vs
 * uptime); with a type, shows that type's form. Posts to the `createMonitor`
 * action on this same route.
 */
function MonitorCreateView({ project, type, formError }: CreateProps) {
  const monitorsBase = `/t/${project.teamSlug}/p/${project.slug}/monitors`;
  const action = `${monitorsBase}/new?createMonitor`;
  const isHttp = type === "http";
  const isTcp = type === "tcp";
  const isBrowser = type === "browser";

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <DetailHeaderBar className="gap-1.5 border-b border-line-1">
        <HeaderCrumbs items={[{ label: "Monitors", href: monitorsBase }]} />
        <h1 className="text-[17px] font-semibold tracking-[-0.2px]">
          New monitor
        </h1>
      </DetailHeaderBar>
      <div className="shrink-0 border-b border-line-1 px-6 py-3">
        <p className="text-[12.5px] text-fg-3">
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

/** The "what do you want to monitor?" cards at `/monitors/new`. */
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
      className="group flex flex-col gap-2.5 rounded-[11px] border border-line-1 bg-bg-1 p-5 transition-colors hover:border-accent/50 hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
    >
      <span className="flex size-10 items-center justify-center rounded-[10px] border border-line-1 bg-bg-2 text-info">
        <MonTypeGlyph size={18} type={glyph} />
      </span>
      <span className="text-[14.5px] font-semibold">{title}</span>
      <span className="text-[12.5px] leading-relaxed text-fg-3">
        {description}
      </span>
    </Link>
  );
}

/**
 * Monitor detail. Type-discriminated: the header/meta/timeline chrome is shared,
 * but a browser monitor shows its Playwright "Test definition" + deep-links each
 * execution to a run report, while an http monitor shows its request config,
 * real time-based uptime, a response-time trend, and per-execution assertion
 * results inline (no run report exists for an http check).
 */
function MonitorDetailView({
  project,
  monitor,
  executions,
  httpConfig,
  tcpConfig,
  uptimeWindows,
  responseTrend,
  uptime,
  nextRunAt,
  editing,
  formError,
  dangerError,
  members,
  groups,
  alertTargets,
}: DetailProps) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const monitorsBase = `${base}/monitors`;
  const here = `${monitorsBase}/${monitor.id}`;
  const enabled = monitor.enabled === 1;
  const alertsOn = monitor.alertsEnabled === 1;
  // Current alert-recipient selection (null = all members) for the picker.
  const selectedUsers = new Set(alertTargets?.users ?? []);
  const selectedGroups = new Set(alertTargets?.groups ?? []);
  const status = monitorDisplayStatus(monitor);
  const isHttp = monitor.type === "http";
  const isTcp = monitor.type === "tcp" || monitor.type === "ping";
  // Members get a read-only detail view; only owners can edit/pause/delete (the
  // actions are owner-gated server-side). `editingOpen` also defends against a
  // member hand-typing `?edit=1`: the edit section stays hidden AND the
  // read-only definition still shows (it keys off `!editingOpen`, not `!editing`).
  const isOwner = project.role === "owner";
  const editingOpen = isOwner && editing;
  // For http + tcp, the header "Uptime 24h" shows the real time-based 24h
  // number; for browser it shows the count-based window uptime.
  const headerUptime = isHttp || isTcp ? (uptimeWindows?.d1 ?? null) : uptime;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Header */}
        <DetailHeaderBar className="gap-3 border-b border-line-1">
          <HeaderCrumbs items={[{ label: "Monitors", href: monitorsBase }]} />
          <h1
            className="flex min-w-0 items-center gap-2 text-[17px] font-semibold tracking-[-0.2px]"
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

              {/* Silence / unsilence alerts — POSTs the desired next state. */}
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
        </DetailHeaderBar>

        {/* Meta row */}
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
            value={<UptimePct value={headerUptime} />}
          />
        </div>

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
                {isHttp ? (
                  <HttpMonitorForm
                    action={`${here}?updateMonitor`}
                    cancelHref={here}
                    defaultConfig={httpConfig ?? undefined}
                    defaultEnabled={enabled}
                    defaultIntervalSeconds={monitor.intervalSeconds}
                    defaultName={monitor.name}
                    error={formError}
                    submitLabel="Save changes"
                  />
                ) : isTcp ? (
                  <TcpMonitorForm
                    action={`${here}?updateMonitor`}
                    cancelHref={here}
                    defaultConfig={tcpConfig ?? undefined}
                    defaultEnabled={enabled}
                    defaultIntervalSeconds={monitor.intervalSeconds}
                    defaultName={monitor.name}
                    error={formError}
                    submitLabel="Save changes"
                  />
                ) : (
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
                )}
              </div>
            </section>
          )}

          {/* Alert recipients (owner-only). Edge-triggered down/recovery
              emails go to these people; "All team members" stores null so new
              members are auto-included. Server-rendered, no island. */}
          {isOwner && (
            <section className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
              <div className="border-b border-line-1 px-[18px] py-3">
                <h3 className="text-[13.5px] font-semibold">
                  Alert recipients
                </h3>
                <p className="mt-0.5 text-[12px] text-fg-3">
                  Who gets the down/recovery emails for this monitor.{" "}
                  <Link
                    className="underline"
                    href={`/settings/teams/${project.teamSlug}/groups`}
                  >
                    Manage groups
                  </Link>
                  .
                </p>
              </div>
              <form
                action={`${here}?setAlertRecipients`}
                className="m-0 px-[18px] py-4"
                method="post"
              >
                <div className="mb-4 flex flex-col gap-1.5 text-[13px]">
                  <label className="flex items-center gap-2">
                    <input
                      defaultChecked={alertTargets === null}
                      name="recipientMode"
                      type="radio"
                      value="all"
                    />
                    All team members
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      defaultChecked={alertTargets !== null}
                      name="recipientMode"
                      type="radio"
                      value="specific"
                    />
                    Specific members or groups
                  </label>
                </div>

                {groups.length > 0 && (
                  <div className="mb-3.5">
                    <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wider text-fg-3">
                      Groups
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {groups.map((g) => (
                        <label
                          key={g.id}
                          className="flex items-center gap-2 text-[13px]"
                        >
                          <input
                            defaultChecked={selectedGroups.has(g.id)}
                            name="group"
                            type="checkbox"
                            value={g.id}
                          />
                          {g.name}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mb-4">
                  <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wider text-fg-3">
                    Members
                  </div>
                  {members.length === 0 ? (
                    <p className="text-[13px] text-fg-3">No members.</p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {members.map((m) => (
                        <label
                          key={m.userId}
                          className="flex items-center gap-2 text-[13px]"
                        >
                          <input
                            defaultChecked={selectedUsers.has(m.userId)}
                            name="user"
                            type="checkbox"
                            value={m.userId}
                          />
                          <span className="font-medium">{m.name}</span>
                          <span className="text-fg-3">{m.email}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <Button size="sm" type="submit">
                  Save recipients
                </Button>
              </form>
            </section>
          )}

          {/* http + tcp: time-based uptime (both); response-time trend (http). */}
          {(isHttp || isTcp) && uptimeWindows && (
            <section className="grid grid-cols-3 gap-3">
              <UptimeStat label="Uptime · 24h" value={uptimeWindows.d1} />
              <UptimeStat label="Uptime · 7d" value={uptimeWindows.d7} />
              <UptimeStat label="Uptime · 30d" value={uptimeWindows.d30} />
            </section>
          )}
          {isHttp && responseTrend && (
            <ResponseTimeCard trend={responseTrend} />
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
                executions.map((ex, i) =>
                  isHttp ? (
                    <HttpExecRow
                      exec={ex}
                      key={ex.id}
                      last={i === executions.length - 1}
                    />
                  ) : isTcp ? (
                    <TcpExecRow
                      exec={ex}
                      key={ex.id}
                      last={i === executions.length - 1}
                    />
                  ) : (
                    <ExecRow
                      base={base}
                      exec={ex}
                      key={ex.id}
                      last={i === executions.length - 1}
                    />
                  ),
                )
              )}
            </div>
          </section>

          {/* Definition / config (read-only when not editing). */}
          {!editingOpen &&
            (isHttp ? (
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
                  title="Request"
                />
                <HttpConfigSummary config={httpConfig} />
              </section>
            ) : isTcp ? (
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
                  title="Connection"
                />
                <TcpConfigSummary config={tcpConfig} />
              </section>
            ) : (
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
            ))}

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
                    Stops the schedule and removes this monitor.
                    {!isHttp &&
                      !isTcp &&
                      " Run reports it already produced are retained."}
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

/** Color an uptime % by the >99 / >95 thresholds the design's meta row uses. */
function UptimePct({ value }: { value: number | null }) {
  if (value == null) return <>—</>;
  return (
    <span
      className={cn(
        value > 99 ? "text-pass" : value > 95 ? "text-degraded" : "text-fail",
      )}
    >
      {value.toFixed(1)}%
    </span>
  );
}

/** A time-based uptime stat card (http detail). */
function UptimeStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-[9px] border border-line-1 bg-bg-1 px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.4px] text-fg-3">
        {label}
      </div>
      <div className="mt-1 font-mono text-[18px] font-semibold tabular-nums">
        <UptimePct value={value} />
      </div>
    </div>
  );
}

/** The response-time trend chart card (24h hourly p50/p95). */
function ResponseTimeCard({
  trend,
}: {
  trend: NonNullable<DetailProps["responseTrend"]>;
}) {
  const series: LineChartSeries[] = [
    { key: "p50", label: "p50", color: "var(--color-foreground)" },
    { key: "p95", label: "p95", color: "var(--accent)" },
  ];
  const buckets: LineChartBucket[] = trend.map((b) => ({
    key: b.key,
    label: b.label,
    values: [b.p50, b.p95],
    tooltip: (
      <div className="font-mono text-[11px]">
        <div className="mb-0.5 text-fg-3">{b.label}</div>
        <div>p50 {b.p50 == null ? "—" : `${Math.round(b.p50)}ms`}</div>
        <div>p95 {b.p95 == null ? "—" : `${Math.round(b.p95)}ms`}</div>
      </div>
    ),
  }));
  return (
    <Card className="overflow-hidden rounded-[9px] border-line-1">
      <div className="border-b border-line-1 px-[18px] py-3">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Response time
        </h2>
        <p className="mt-0.5 text-[11.5px] text-fg-3">
          Last 24h — p50 and p95 per hour (UTC).
        </p>
      </div>
      <CardPanel className="px-[18px] py-4">
        <AnalyticsLineChart
          ariaLabel="Response time p50 and p95 over the last 24 hours"
          buckets={buckets}
          emptyState="No checks with a response in the last 24h."
          formatYTick={(ms) => formatDuration(Math.round(ms))}
          height={260}
          series={series}
        />
        <div className="mt-3.5 flex items-center gap-3.5 text-[11.5px] text-fg-3">
          {series.map((s) => (
            <span className="inline-flex items-center gap-1.5" key={s.key}>
              <span className="h-0.5 w-3" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </CardPanel>
    </Card>
  );
}

/** Read-only summary of an http monitor's request config. */
function HttpConfigSummary({ config }: { config: DetailProps["httpConfig"] }) {
  if (!config) {
    return (
      <div className="rounded-[9px] border border-fail/30 bg-fail-soft px-[18px] py-4 text-[12.5px] text-fail">
        This monitor's configuration is missing or invalid — edit it to fix.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
      <div className="flex items-center gap-2 border-b border-line-1 px-[18px] py-3">
        <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fg-2">
          GET
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {config.url}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-[18px] py-3.5 text-[12.5px] sm:grid-cols-4">
        <ConfigField
          label="Degraded above"
          value={`${config.degradedResponseTimeMs}ms`}
        />
        <ConfigField
          label="Fail above"
          value={`${config.maxResponseTimeMs}ms`}
        />
        <ConfigField
          label="Redirects"
          value={config.followRedirects ? "follow" : "manual"}
        />
        <ConfigField
          label="Expectation"
          value={config.shouldFail ? "should fail" : "should succeed"}
        />
      </div>
      {config.assertions.length > 0 && (
        <div className="border-t border-line-1 px-[18px] py-3.5">
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.4px] text-fg-3">
            Assertions
          </div>
          <div className="flex flex-col gap-1.5">
            {config.assertions.map((a, i) => (
              <div className="font-mono text-[12px] text-fg-2" key={i}>
                <span className="text-foreground">{a.source}</span>
                {a.property ? (
                  <span className="text-fg-3"> {a.property}</span>
                ) : null}{" "}
                <span className="text-accent">{a.comparison}</span>
                {a.target ? <span> {a.target}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.4px] text-fg-3">
        {label}
      </span>
      <span className="font-mono text-fg-1">{value}</span>
    </div>
  );
}

/** A description line for a browser execution, keyed off its terminal state. */
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

/** One browser execution row in the timeline (deep-links to the run report). */
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

/** Color a status-code chip by its class (2xx/3xx ok, 4xx/5xx bad). */
function statusCodeClass(code: number): string {
  return code < 400 ? "text-pass" : "text-fail";
}

/**
 * One http execution row — an expandable `<details>` (no-JS) whose summary shows
 * status code + duration + the result line, and whose body shows the assertion
 * results, timing phases, and the redirect chain from `resultDetail`.
 */
function HttpExecRow({
  exec,
  last,
}: {
  exec: MonitorExecution;
  last: boolean;
}) {
  const isRunning = exec.state === "running";
  const detail = parseHttpResultDetail(exec.resultDetail);
  const expandable =
    detail != null &&
    (detail.assertions.length > 0 ||
      detail.bodyExcerpt != null ||
      exec.statusCode != null);

  const summary = (
    <div
      className={cn(
        "flex items-center gap-3 px-[18px] py-[11px] transition-colors hover:bg-bg-2",
        expandable && "cursor-pointer",
      )}
    >
      <MonGlyph size={14} state={exec.state} />
      <div className="w-[92px] shrink-0">
        <MonBadge size="sm" state={exec.state} />
      </div>
      <span className="w-[42px] shrink-0 text-right font-mono text-[12px] tabular-nums">
        {exec.statusCode != null ? (
          <span className={statusCodeClass(exec.statusCode)}>
            {exec.statusCode}
          </span>
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </span>
      <div
        className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2"
        title={exec.errorMessage ?? undefined}
      >
        {isRunning ? (
          <span className="text-running">running now…</span>
        ) : exec.errorMessage ? (
          exec.errorMessage
        ) : (
          <span className="text-fg-3">responded OK</span>
        )}
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
      <span className="flex w-[18px] justify-end">
        {expandable && (
          <ChevronDown className="size-3.5 text-fg-3 transition-transform group-open:rotate-180" />
        )}
      </span>
    </div>
  );

  const rail = cn(
    "border-l-2",
    last ? "border-b-0" : "border-b border-b-line-1",
    exec.state === "fail"
      ? "border-l-fail"
      : exec.state === "error"
        ? "border-l-error"
        : "border-l-transparent",
  );

  if (!expandable) {
    return <div className={rail}>{summary}</div>;
  }

  return (
    <details className={cn("group", rail)}>
      <summary className="list-none [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {detail && <HttpExecDetail detail={detail} />}
    </details>
  );
}

/** The expanded body of an http execution row: assertions + timings + chain. */
function HttpExecDetail({ detail }: { detail: HttpResultDetail }) {
  return (
    <div className="border-t border-line-1 bg-bg-0 px-[18px] py-3.5">
      {detail.assertions.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.4px] text-fg-3">
            Assertions
          </div>
          <div className="flex flex-col gap-1">
            {detail.assertions.map((a, i) => (
              <div
                className="flex items-center gap-2 font-mono text-[12px]"
                key={i}
              >
                {a.pass ? (
                  <Check className="size-3.5 shrink-0 text-pass" />
                ) : (
                  <XIcon className="size-3.5 shrink-0 text-fail" />
                )}
                <span className="text-fg-2">
                  <span className="text-foreground">{a.source}</span>
                  {a.property ? (
                    <span className="text-fg-3"> {a.property}</span>
                  ) : null}{" "}
                  <span className="text-accent">{a.comparison}</span>
                  {a.target ? <span> {a.target}</span> : null}
                </span>
                <span className="text-fg-3">
                  → got {a.actual === null ? "nothing" : `"${a.actual}"`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px] text-fg-3">
        <span>
          ttfb{" "}
          {detail.timings.ttfbMs == null
            ? "—"
            : `${Math.round(detail.timings.ttfbMs)}ms`}
        </span>
        <span>
          download{" "}
          {detail.timings.downloadMs == null
            ? "—"
            : `${Math.round(detail.timings.downloadMs)}ms`}
        </span>
        <span>total {Math.round(detail.timings.totalMs)}ms</span>
        {detail.redirected && <span>· redirected</span>}
      </div>
      <div
        className="mt-1.5 truncate font-mono text-[11.5px] text-fg-3"
        title={detail.finalUrl}
      >
        {detail.finalUrl}
      </div>
      {detail.bodyExcerpt != null && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-line-1 bg-bg-1 p-2.5 font-mono text-[11px] leading-relaxed text-fg-2">
          {detail.bodyExcerpt}
        </pre>
      )}
    </div>
  );
}

/** Read-only summary of a tcp monitor's connection config (host:port + timeout). */
function TcpConfigSummary({ config }: { config: DetailProps["tcpConfig"] }) {
  if (!config) {
    return (
      <div className="rounded-[9px] border border-fail/30 bg-fail-soft px-[18px] py-4 text-[12.5px] text-fail">
        This monitor's configuration is missing or invalid — edit it to fix.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
      <div className="flex items-center gap-2 border-b border-line-1 px-[18px] py-3">
        <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fg-2">
          TCP
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {config.host}:{config.port}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-[18px] py-3.5 text-[12.5px]">
        <ConfigField label="Host" value={config.host} />
        <ConfigField label="Port" value={String(config.port)} />
        <ConfigField
          label="Connect timeout"
          value={`${config.connectTimeoutMs}ms`}
        />
        <ConfigField label="Probe" value="TCP connect" />
      </div>
    </div>
  );
}

/**
 * One tcp execution row — an expandable `<details>` (no-JS) whose summary shows
 * the result line + connect duration, and whose body shows the host:port dialed
 * and the connect/total timing phases from `resultDetail`.
 */
function TcpExecRow({ exec, last }: { exec: MonitorExecution; last: boolean }) {
  const isRunning = exec.state === "running";
  const detail = parseTcpResultDetail(exec.resultDetail);
  const expandable = detail != null;

  const summary = (
    <div
      className={cn(
        "flex items-center gap-3 px-[18px] py-[11px] transition-colors hover:bg-bg-2",
        expandable && "cursor-pointer",
      )}
    >
      <MonGlyph size={14} state={exec.state} />
      <div className="w-[92px] shrink-0">
        <MonBadge size="sm" state={exec.state} />
      </div>
      <div
        className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2"
        title={exec.errorMessage ?? undefined}
      >
        {isRunning ? (
          <span className="text-running">connecting now…</span>
        ) : exec.errorMessage ? (
          exec.errorMessage
        ) : detail ? (
          <span className="text-fg-3">
            connected to{" "}
            <span className="font-mono text-fg-2">
              {detail.host}:{detail.port}
            </span>
          </span>
        ) : (
          <span className="text-fg-3">connected</span>
        )}
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
      <span className="flex w-[18px] justify-end">
        {expandable && (
          <ChevronDown className="size-3.5 text-fg-3 transition-transform group-open:rotate-180" />
        )}
      </span>
    </div>
  );

  const rail = cn(
    "border-l-2",
    last ? "border-b-0" : "border-b border-b-line-1",
    exec.state === "fail"
      ? "border-l-fail"
      : exec.state === "error"
        ? "border-l-error"
        : "border-l-transparent",
  );

  if (!expandable) {
    return <div className={rail}>{summary}</div>;
  }

  return (
    <details className={cn("group", rail)}>
      <summary className="list-none [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {detail && <TcpExecDetail detail={detail} />}
    </details>
  );
}

/** The expanded body of a tcp execution row: host:port + connect/total timings. */
function TcpExecDetail({ detail }: { detail: TcpResultDetail }) {
  return (
    <div className="border-t border-line-1 bg-bg-0 px-[18px] py-3.5">
      <div
        className="mb-1.5 truncate font-mono text-[12px] text-fg-2"
        title={`${detail.host}:${detail.port}`}
      >
        <span className="text-fg-3">target </span>
        {detail.host}:{detail.port}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px] text-fg-3">
        <span>connect {Math.round(detail.timings.connectMs)}ms</span>
        <span>total {Math.round(detail.timings.totalMs)}ms</span>
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
