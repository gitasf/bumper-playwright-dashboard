import { use } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  X as XIcon,
} from "lucide-react";
import {
  AnalyticsLineChart,
  type LineChartBucket,
  type LineChartSeries,
} from "@/components/analytics/line-chart";
import { MonBadge, MonGlyph } from "@/components/monitors/monitor-status";
import { ChartSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Disclosure } from "@/components/disclosure";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import {
  parseHttpResultDetail,
  parseTcpResultDetail,
} from "@/lib/monitors/monitor-schemas";
import type { HttpResultDetail, TcpResultDetail } from "@/lib/monitors/types";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { MonitorExecution } from "@schema";
import type { Props } from "./index.server";

type DetailProps = Extract<Props, { mode: "detail" }>;
type DetailData = Awaited<DetailProps["detail"]>;

export function HeaderUptime({ detail }: { detail: DetailProps["detail"] }) {
  const { uptimeWindows } = use(detail);
  return <UptimePct value={uptimeWindows?.d1 ?? null} />;
}

export function AnalyticsAndExecutions({
  detail,
  base,
  isHttp,
  isTcp,
  enabled,
}: {
  detail: DetailProps["detail"];
  base: string;
  isHttp: boolean;
  isTcp: boolean;
  enabled: boolean;
}) {
  const { executions, uptimeWindows, responseTrend } = use(detail);

  return (
    <>
      {uptimeWindows && (
        <section className="grid grid-cols-3 gap-3">
          <UptimeStat label="Uptime · 24h" value={uptimeWindows.d1} />
          <UptimeStat label="Uptime · 7d" value={uptimeWindows.d7} />
          <UptimeStat label="Uptime · 30d" value={uptimeWindows.d30} />
        </section>
      )}
      {isHttp && responseTrend && <ResponseTimeCard trend={responseTrend} />}

      <section>
        <SectionTitle
          right={
            executions.length > 0 ? (
              <span className="text-caption text-fg-3">
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
              <div className="text-body-lg font-medium">No executions yet</div>
              <div className="mx-auto mt-1 max-w-[360px] text-body leading-relaxed text-fg-3">
                {enabled
                  ? "The first execution will appear here once the scheduler picks this monitor up — usually within a minute."
                  : "This monitor is paused. Resume it to start collecting executions."}
              </div>
            </div>
          ) : (
            executions.map((execution, index) =>
              isHttp ? (
                <HttpExecRow
                  exec={execution}
                  key={execution.id}
                  last={index === executions.length - 1}
                />
              ) : isTcp ? (
                <TcpExecRow
                  exec={execution}
                  key={execution.id}
                  last={index === executions.length - 1}
                />
              ) : (
                <ExecRow
                  base={base}
                  exec={execution}
                  key={execution.id}
                  last={index === executions.length - 1}
                />
              ),
            )
          )}
        </div>
      </section>
    </>
  );
}

export function AnalyticsAndExecutionsSkeleton({
  isHttp,
}: {
  isHttp: boolean;
}) {
  return (
    <>
      <section className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            className="rounded-[9px] border border-line-1 bg-bg-1 px-4 py-3"
            key={index}
          >
            <Skeleton className="h-[13px] w-16" />
            <Skeleton className="mt-1.5 h-[18px] w-14" />
          </div>
        ))}
      </section>
      {isHttp && (
        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="border-b border-line-1 px-[18px] py-3">
            <Skeleton className="h-[15px] w-28" />
            <Skeleton className="mt-1.5 h-[13px] w-56" />
          </div>
          <CardPanel className="px-[18px] py-4">
            <ChartSkeleton height={260} />
          </CardPanel>
        </Card>
      )}
      <section>
        <SectionTitle title="Executions" />
        <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              className={cn(
                "flex items-center gap-3 px-[18px] py-[11px]",
                index < 5 && "border-b border-b-line-1",
              )}
              key={index}
            >
              <Skeleton className="size-3.5 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-[92px] shrink-0 rounded-full" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-[70px] shrink-0" />
              <Skeleton className="h-3 w-[96px] shrink-0" />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function HttpConfigSummary({
  config,
}: {
  config: DetailProps["httpConfig"];
}) {
  if (!config) {
    return (
      <div className="rounded-[9px] border border-fail/30 bg-fail-soft px-[18px] py-4 text-body text-fail">
        This monitor's configuration is missing or invalid — edit it to fix.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
      <div className="flex items-center gap-2 border-b border-line-1 px-[18px] py-3">
        <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-micro font-semibold text-fg-2">
          GET
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-body text-fg-1">
          {config.url}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-[18px] py-3.5 text-body sm:grid-cols-4">
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
          <div className="mb-2 text-caption font-medium tracking-[0.1px] text-fg-3">
            Assertions
          </div>
          <div className="flex flex-col gap-1.5">
            {config.assertions.map((assertion, index) => (
              <div className="font-mono text-caption text-fg-2" key={index}>
                <span className="text-fg-1">{assertion.source}</span>
                {assertion.property ? (
                  <span className="text-fg-3"> {assertion.property}</span>
                ) : null}{" "}
                <span className="text-info">{assertion.comparison}</span>
                {assertion.target ? <span> {assertion.target}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TcpConfigSummary({
  config,
}: {
  config: DetailProps["tcpConfig"];
}) {
  if (!config) {
    return (
      <div className="rounded-[9px] border border-fail/30 bg-fail-soft px-[18px] py-4 text-body text-fail">
        This monitor's configuration is missing or invalid — edit it to fix.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[9px] border border-line-1 bg-bg-1">
      <div className="flex items-center gap-2 border-b border-line-1 px-[18px] py-3">
        <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-micro font-semibold text-fg-2">
          TCP
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-body text-fg-1">
          {config.host}:{config.port}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-[18px] py-3.5 text-body">
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

function ConfigField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </span>
      <span className="font-mono text-fg-1">{value}</span>
    </div>
  );
}

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

function UptimeStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-[9px] border border-line-1 bg-bg-1 px-4 py-3">
      <div className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </div>
      <div className="mt-1 font-mono text-heading font-semibold tabular-nums">
        <UptimePct value={value} />
      </div>
    </div>
  );
}

function ResponseTimeCard({
  trend,
}: {
  trend: NonNullable<DetailData["responseTrend"]>;
}) {
  const series: LineChartSeries[] = [
    { key: "p50", label: "p50", color: "var(--color-foreground)" },
    { key: "p95", label: "p95", color: "var(--accent)" },
  ];
  const buckets: LineChartBucket[] = trend.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    values: [bucket.p50, bucket.p95],
    tooltip: (
      <div className="font-mono text-micro">
        <div className="mb-0.5 text-fg-3">{bucket.label}</div>
        <div>
          p50 {bucket.p50 == null ? "—" : `${Math.round(bucket.p50)}ms`}
        </div>
        <div>
          p95 {bucket.p95 == null ? "—" : `${Math.round(bucket.p95)}ms`}
        </div>
      </div>
    ),
  }));

  return (
    <Card className="overflow-hidden rounded-[9px] border-line-1">
      <div className="border-b border-line-1 px-[18px] py-3">
        <h2 className="text-body font-semibold tracking-tight">
          Response time
        </h2>
        <p className="mt-0.5 text-caption text-fg-3">
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
        <div className="mt-3.5 flex items-center gap-3.5 text-caption text-fg-3">
          {series.map((item) => (
            <span className="inline-flex items-center gap-1.5" key={item.key}>
              <span className="h-0.5 w-3" style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </CardPanel>
    </Card>
  );
}

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
      <div className="min-w-0 flex-1 text-body text-fg-2">
        {execDescription(exec.state)}
      </div>
      <span className="w-[70px] text-right font-mono text-caption tabular-nums text-fg-3">
        {exec.durationMs != null ? formatDuration(exec.durationMs) : "—"}
      </span>
      <span className="w-[96px] text-right text-caption">
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
          <span className="text-caption text-fg-4">
            {isRunning ? "in progress" : "no report"}
          </span>
        )}
      </div>
    </div>
  );
}

function statusCodeClass(code: number): string {
  return code < 400 ? "text-pass" : "text-fail";
}

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
      <span className="w-[42px] shrink-0 text-right font-mono text-caption tabular-nums">
        {exec.statusCode != null ? (
          <span className={statusCodeClass(exec.statusCode)}>
            {exec.statusCode}
          </span>
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </span>
      <div
        className="min-w-0 flex-1 truncate text-body text-fg-2"
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
      <span className="w-[70px] text-right font-mono text-caption tabular-nums text-fg-3">
        {exec.durationMs != null ? formatDuration(exec.durationMs) : "—"}
      </span>
      <span className="w-[96px] text-right text-caption">
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
          <ChevronDown className="size-3.5 text-fg-3 transition-transform group-data-[panel-open]/disclosure:rotate-180" />
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
    <Disclosure className={rail} summary={summary}>
      {detail && <HttpExecDetail detail={detail} />}
    </Disclosure>
  );
}

function HttpExecDetail({ detail }: { detail: HttpResultDetail }) {
  return (
    <div className="border-t border-line-1 bg-bg-0 px-[18px] py-3.5">
      {detail.assertions.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-caption font-medium tracking-[0.1px] text-fg-3">
            Assertions
          </div>
          <div className="flex flex-col gap-1">
            {detail.assertions.map((assertion, index) => (
              <div
                className="flex items-center gap-2 font-mono text-caption"
                key={index}
              >
                {assertion.pass ? (
                  <Check className="size-3.5 shrink-0 text-pass" />
                ) : (
                  <XIcon className="size-3.5 shrink-0 text-fail" />
                )}
                <span className="text-fg-2">
                  <span className="text-fg-1">{assertion.source}</span>
                  {assertion.property ? (
                    <span className="text-fg-3"> {assertion.property}</span>
                  ) : null}{" "}
                  <span className="text-info">{assertion.comparison}</span>
                  {assertion.target ? <span> {assertion.target}</span> : null}
                </span>
                <span className="text-fg-3">
                  → got{" "}
                  {assertion.actual === null
                    ? "nothing"
                    : `"${assertion.actual}"`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-caption text-fg-3">
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
        className="mt-1.5 truncate font-mono text-caption text-fg-3"
        title={detail.finalUrl}
      >
        {detail.finalUrl}
      </div>
      {detail.bodyExcerpt != null && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-line-1 bg-bg-1 p-2.5 font-mono text-micro leading-relaxed text-fg-2">
          {detail.bodyExcerpt}
        </pre>
      )}
    </div>
  );
}

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
        className="min-w-0 flex-1 truncate text-body text-fg-2"
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
      <span className="w-[70px] text-right font-mono text-caption tabular-nums text-fg-3">
        {exec.durationMs != null ? formatDuration(exec.durationMs) : "—"}
      </span>
      <span className="w-[96px] text-right text-caption">
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
          <ChevronDown className="size-3.5 text-fg-3 transition-transform group-data-[panel-open]/disclosure:rotate-180" />
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
    <Disclosure className={rail} summary={summary}>
      {detail && <TcpExecDetail detail={detail} />}
    </Disclosure>
  );
}

function TcpExecDetail({ detail }: { detail: TcpResultDetail }) {
  return (
    <div className="border-t border-line-1 bg-bg-0 px-[18px] py-3.5">
      <div
        className="mb-1.5 truncate font-mono text-caption text-fg-2"
        title={`${detail.host}:${detail.port}`}
      >
        <span className="text-fg-3">target </span>
        {detail.host}:{detail.port}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-caption text-fg-3">
        <span>connect {Math.round(detail.timings.connectMs)}ms</span>
        <span>total {Math.round(detail.timings.totalMs)}ms</span>
      </div>
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
