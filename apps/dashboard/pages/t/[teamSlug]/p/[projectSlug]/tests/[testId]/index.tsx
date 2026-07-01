import { Link } from "@void/react";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { QuarantineControl } from "@/components/quarantine-control";
import {
  RUN_HISTORY_CHART_MAX_POINTS,
  RunHistoryChart,
} from "@/components/run-history-chart";
import { StatusBadge } from "@/components/status-badge";
import { StatusGlyph } from "@/components/status-glyph";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { firstLine } from "@/lib/text";
import { buildTestHistoryView } from "@/lib/test-history-view";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./index.server";

/**
 * Per-test history page (`/t/:team/p/:project/tests/:testId`). The test-level
 * counterpart to the run-scoped result detail: a duration trend, headline
 * stats, and a recent-runs table for one stable `testId`, decoupled from any
 * single run. Each history row links INTO the run-scoped result detail (the
 * artifact/attempt deep-dive). The loader returns `kind: "ok"` or
 * `kind: "not_found"` so this component doesn't gate existence itself.
 */
export default function TestHistoryPage(props: Props) {
  if (props.kind === "not_found") {
    const { project, testId } = props;
    const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;
    return (
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <h1 className="mb-2 font-semibold text-2xl">Test not found</h1>
        <p className="mb-4 text-muted-foreground text-sm">
          No runs recorded for test{" "}
          <span className="font-mono text-foreground">{testId}</span> in this
          project.
        </p>
        <Link
          className="text-foreground underline-offset-4 hover:underline"
          href={`${base}/tests`}
        >
          Back to tests catalog
        </Link>
      </div>
    );
  }

  const {
    project,
    testId,
    meta,
    stats,
    tags,
    quarantine,
    quarantineRedirectTo,
    quarantineError,
    history,
  } = props;

  const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;
  const quarantineActionPath = `/api/t/${project.teamSlug}/p/${project.projectSlug}/quarantine`;

  // Chart points + the visible-window pass/fail/flaky summary. The summary
  // reflects the "last N runs" the chart plots, not the all-time KPIs above.
  // `history` is loaded newest-first up to HISTORY_LIMIT (60), but the chart
  // only draws the most recent RUN_HISTORY_CHART_MAX_POINTS (30) — slice to the
  // same window so the title count and summary describe exactly what's drawn.
  const { points: historyPoints, stats: windowStats } = buildTestHistoryView(
    history.slice(0, RUN_HISTORY_CHART_MAX_POINTS),
    {
      base,
      teamSlug: project.teamSlug,
      projectSlug: project.projectSlug,
    },
  );

  return (
    <>
      <DetailHeaderBar className="justify-between gap-4 border-b border-border">
        <div className="flex min-w-0 items-center gap-3">
          <HeaderCrumbs items={[{ label: "Tests", href: `${base}/tests` }]} />
          <StatusBadge status={meta.latestStatus} />
          <h1 className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.2px]">
            {meta.testTitle}
          </h1>
        </div>
        <QuarantineControl
          actionPath={quarantineActionPath}
          canManage={project.canManageQuarantine}
          quarantine={quarantine}
          redirectTo={quarantineRedirectTo}
          testId={testId}
          title={meta.testTitle}
        />
      </DetailHeaderBar>

      {/* Metadata + tags, below the title bar. */}
      <div className="shrink-0 border-b border-border px-6 pt-3 pb-3">
        <div className="font-mono text-muted-foreground text-xs">
          {meta.describeChain.length > 0
            ? `${meta.describeChain.join(" › ")} · `
            : ""}
          {meta.file}
          {meta.projectName ? ` · ${meta.projectName}` : ""}
          {stats.firstSeen
            ? ` · tracked since ${formatRelativeTime(stats.firstSeen)}`
            : ""}
        </div>
        {quarantineError && (
          <Alert className="mt-3" variant="error">
            <AlertDescription>{quarantineError}</AlertDescription>
          </Alert>
        )}
        {tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Badge key={tag} size="sm" variant="info">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AnalyticsKpiCard
            footnote={`${stats.passedCount.toLocaleString()} of ${stats.executed.toLocaleString()} executed`}
            label="Pass rate"
            value={`${stats.passRate.toFixed(1)}%`}
          />
          <AnalyticsKpiCard
            footnote={`${stats.flakyCount.toLocaleString()} flaky · ${stats.failCount.toLocaleString()} failed`}
            label="Flakiness rate"
            value={`${stats.flakyRate.toFixed(1)}%`}
          />
          <AnalyticsKpiCard
            footnote={
              stats.p95DurationMs === null
                ? "no timing data"
                : `p95 ${formatDuration(stats.p95DurationMs)}`
            }
            label="Avg duration"
            value={
              stats.avgDurationMs === null
                ? "—"
                : formatDuration(Math.round(stats.avgDurationMs))
            }
          />
          <AnalyticsKpiCard
            footnote={
              stats.lastSeen
                ? `last seen ${formatRelativeTime(stats.lastSeen)}`
                : undefined
            }
            label="Total runs"
            value={stats.totalRuns.toLocaleString()}
          />
        </div>

        <RunHistoryChart
          emptyState="No prior runs recorded for this test yet."
          points={historyPoints}
          rightSlot={
            historyPoints.length > 1 ? (
              <>
                <span>pass {windowStats.passPct}%</span>
                <span style={{ color: "var(--color-destructive)" }}>
                  × {windowStats.failed}
                </span>
                <span style={{ color: "var(--color-warning)" }}>
                  ⚠ {windowStats.flaky}
                </span>
              </>
            ) : null
          }
          subtitle={meta.file}
          title={`Duration · last ${historyPoints.length} run${
            historyPoints.length === 1 ? "" : "s"
          } of this test`}
        />

        <Card className="overflow-hidden rounded-[9px]">
          <div className="border-b border-border px-[18px] py-3">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Recent runs
            </h2>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {history.length === stats.totalRuns
                ? `All ${stats.totalRuns.toLocaleString()} runs of this test.`
                : `Most recent ${history.length} of ${stats.totalRuns.toLocaleString()} runs. Open a row for attempts, errors, and artifacts.`}
            </p>
          </div>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 px-4" />
                <TableHead className="px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Run
                </TableHead>
                <TableHead className="w-[220px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Branch
                </TableHead>
                <TableHead className="w-[110px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Duration
                </TableHead>
                <TableHead className="w-[110px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  When
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((h) => {
                const href = `${base}/runs/${h.runId}/tests/${h.testResultId}`;
                const shortId = h.runId.slice(-7);
                const message = firstLine(h.commitMessage);
                return (
                  <TableRow key={h.testResultId}>
                    <TableCell className="w-10 px-4 py-3 align-middle">
                      {/* Stretched-link: the static <Link>'s after:inset-0 fills
                       * the `relative` TableRow, making the whole row clickable. */}
                      <Link
                        className="flex items-center justify-center after:absolute after:inset-0 after:rounded-sm focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                        href={href}
                      >
                        <span className="sr-only">
                          View {meta.testTitle} in run #{shortId}
                        </span>
                        <StatusGlyph size={13} status={h.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
                          #{shortId}
                        </span>
                        {message ? (
                          <span
                            className="truncate text-[13px] text-foreground"
                            title={message}
                          >
                            {message}
                          </span>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">
                            {h.actor ?? "—"}
                          </span>
                        )}
                        {h.retryCount > 0 && (
                          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                            {h.retryCount} retr
                            {h.retryCount === 1 ? "y" : "ies"}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="w-[220px] px-4 py-3 align-middle">
                      <span
                        className="block truncate font-mono text-[11.5px] text-muted-foreground"
                        title={h.branch ?? undefined}
                      >
                        {h.branch ?? "—"}
                        {h.commitSha ? ` · ${h.commitSha.slice(0, 7)}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="w-[110px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums text-foreground">
                      {formatDuration(h.durationMs)}
                    </TableCell>
                    <TableCell className="w-[110px] px-4 py-3 text-right align-middle text-[12px] text-muted-foreground">
                      {formatRelativeTime(h.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
