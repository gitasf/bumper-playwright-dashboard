import { use } from "react";
import { RowLink } from "@/components/row-link";
import { Link } from "@/components/ui/link";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { DeferredSection } from "@/components/defer-error-boundary";
import { OwnerAssignControl } from "@/components/owner-assign-popover";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { QuarantineControl } from "@/components/quarantine-control";
import {
  RUN_HISTORY_CHART_MAX_POINTS,
  RunHistoryChart,
  RunHistoryChartSkeleton,
} from "@/components/run/history-chart";
import { KpiCardSkeleton } from "@/components/skeletons";
import { StatusBadge } from "@/components/status-badge";
import { StatusGlyph } from "@/components/status-glyph";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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

/** The `ok`-variant props, narrowed so the sub-components can name the shape. */
type OkProps = Extract<Props, { kind: "ok" }>;

/**
 * Per-test history page (`/t/:team/p/:project/tests/:testId`). The test-level
 * counterpart to the run-scoped result detail: a duration trend, headline
 * stats, and a recent-runs table for one stable `testId`, decoupled from any
 * single run. Each history row links INTO the run-scoped result detail (the
 * artifact/attempt deep-dive). The loader returns `kind: "ok"` or
 * `kind: "not_found"` so this component doesn't gate existence itself.
 *
 * The header paints from the eager latest-result read. Everything else streams
 * behind skeletons in two independent `defer()` groups: the KPI strip reads
 * `stats`; the owner/quarantine controls, tag row, and chart + recent-runs
 * table read `details`.
 */
export default function TestHistoryPage(props: Props) {
  if (props.kind === "not_found") {
    const { project, testId } = props;
    const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;
    return (
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <h1 className="mb-2 font-semibold text-title">Test not found</h1>
        <p className="mb-4 text-fg-3 text-sm">
          No runs recorded for test{" "}
          <span className="font-mono text-fg-1">{testId}</span> in this project.
        </p>
        <Link
          className="text-fg-1 underline-offset-4 hover:underline"
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
    quarantineRedirectTo,
    quarantineError,
    ownerError,
    details,
  } = props;

  const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;
  const quarantineActionPath = `/api/t/${project.teamSlug}/p/${project.projectSlug}/quarantine`;
  const ownerActionPath = `/api/t/${project.teamSlug}/p/${project.projectSlug}/owners`;

  return (
    <>
      <DetailHeaderBar className="justify-between gap-4 border-b border-line-1">
        <div className="flex min-w-0 items-center gap-3">
          <HeaderCrumbs items={[{ label: "Tests", href: `${base}/tests` }]} />
          <StatusBadge status={meta.latestStatus} />
          <h1 className="min-w-0 truncate text-heading font-semibold tracking-[-0.2px]">
            {meta.testTitle}
          </h1>
        </div>
        {/* Ownership + quarantine state are DB reads → deferred; the controls
         * stream in on the right of the header behind small skeletons. */}
        <DeferredSection
          errorFallback={null}
          skeleton={<HeaderControlsSkeleton />}
        >
          <HeaderControlsRegion
            details={details}
            ownerActionPath={ownerActionPath}
            project={project}
            quarantineActionPath={quarantineActionPath}
            redirectTo={quarantineRedirectTo}
            testId={testId}
            title={meta.testTitle}
          />
        </DeferredSection>
      </DetailHeaderBar>

      {/* Metadata + tags, below the title bar. */}
      <div className="shrink-0 border-b border-line-1 px-6 pt-3 pb-3">
        <div className="font-mono text-fg-3 text-xs">
          {meta.describeChain.length > 0
            ? `${meta.describeChain.join(" › ")} · `
            : ""}
          {meta.file}
          {meta.projectName ? ` · ${meta.projectName}` : ""}
          {/* `firstSeen` is in the deferred aggregate — render nothing while
           * pending/absent rather than skeleton this trailing footnote. */}
          <DeferredSection errorFallback={null} skeleton={null}>
            <TrackedSinceLabel stats={stats} />
          </DeferredSection>
        </div>
        {quarantineError && (
          <Alert className="mt-3" variant="error">
            <AlertDescription>{quarantineError}</AlertDescription>
          </Alert>
        )}
        {ownerError && (
          <Alert className="mt-3" variant="error">
            <AlertDescription>{ownerError}</AlertDescription>
          </Alert>
        )}
        {/* Tags are a DB union → deferred. The skeleton shows a couple of badge
         * shimmers; when the test has no tags the resolved region renders
         * nothing (matching the prior `tags.length > 0` guard). */}
        <DeferredSection errorFallback={null} skeleton={<TagsRowSkeleton />}>
          <TagsRow details={details} />
        </DeferredSection>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {/* KPI strip — reads deferred `stats` independently of `details`, so
         * the heavy percentile query and recent-runs region don't block each
         * other. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <DeferredSection skeleton={<KpiStripSkeleton />}>
            <KpiStrip stats={stats} />
          </DeferredSection>
        </div>

        {/* Chart + recent-runs table read the deferred history slice; the
         * "of N total runs" caption also reads the deferred `stats` total. */}
        <DeferredSection
          skeleton={<HistoryRegionSkeleton subtitle={meta.file} />}
        >
          <HistoryRegion
            base={base}
            details={details}
            file={meta.file}
            projectSlug={project.projectSlug}
            stats={stats}
            teamSlug={project.teamSlug}
            testTitle={meta.testTitle}
          />
        </DeferredSection>
      </div>
    </>
  );
}

/** Header-right ownership + quarantine controls — both read the deferred
 *  `details` group (owners / member options / quarantine state). */
function HeaderControlsRegion({
  details,
  project,
  ownerActionPath,
  quarantineActionPath,
  redirectTo,
  testId,
  title,
}: {
  details: OkProps["details"];
  project: OkProps["project"];
  ownerActionPath: string;
  quarantineActionPath: string;
  redirectTo: string;
  testId: string;
  title: string;
}) {
  const { quarantine, owners, assignableMembers } = use(details);
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-3">
      <OwnerAssignControl
        actionPath={ownerActionPath}
        canManage={project.canManageOwners}
        members={assignableMembers}
        owners={owners}
        redirectTo={redirectTo}
        team={{ slug: project.teamSlug, name: project.teamName }}
        testId={testId}
        title={title}
      />
      <QuarantineControl
        actionPath={quarantineActionPath}
        canManage={project.canManageQuarantine}
        quarantine={quarantine}
        redirectTo={redirectTo}
        testId={testId}
        title={title}
      />
    </div>
  );
}

/** Fallback for the header-right controls while their state resolves. */
function HeaderControlsSkeleton() {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Skeleton className="h-8 w-16 rounded-md" />
      <Skeleton className="h-8 w-24 rounded-md" />
    </div>
  );
}

/** The tag row in the metadata bar — reads the deferred `tags` union. Renders
 *  nothing when the test carries no tags (matching the prior guard). */
function TagsRow({ details }: { details: OkProps["details"] }) {
  const { tags } = use(details);
  if (tags.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {tags.map((tag) => (
        <Badge key={tag} size="sm" variant="info">
          {tag}
        </Badge>
      ))}
    </div>
  );
}

/** Fallback for the tag row: a couple of badge shimmers. Tag count is unknown
 *  until the union resolves, and the region below (KPI strip) is scrollable, so
 *  a small residual shift when there are zero tags is acceptable here. */
function TagsRowSkeleton() {
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      <Skeleton className="h-5 w-16 rounded-full" />
      <Skeleton className="h-5 w-20 rounded-full" />
    </div>
  );
}

/** Metadata bar's trailing "· tracked since …" footnote — reads deferred
 *  `stats.firstSeen`; renders nothing until it resolves (or if it's absent). */
function TrackedSinceLabel({ stats }: { stats: OkProps["stats"] }) {
  const { firstSeen } = use(stats);
  if (!firstSeen) return null;
  return <> · tracked since {formatRelativeTime(firstSeen)}</>;
}

/** KPI strip — one `use(stats)` shared by all four cards so they resolve
 *  together. */
function KpiStrip({ stats }: { stats: OkProps["stats"] }) {
  const s = use(stats);
  return (
    <>
      <AnalyticsKpiCard
        footnote={`${s.passedCount.toLocaleString()} of ${s.executed.toLocaleString()} executed`}
        label="Pass rate"
        value={`${s.passRate.toFixed(1)}%`}
      />
      <AnalyticsKpiCard
        footnote={`${s.flakyCount.toLocaleString()} flaky · ${s.failCount.toLocaleString()} failed`}
        label="Flakiness rate"
        value={`${s.flakyRate.toFixed(1)}%`}
      />
      <AnalyticsKpiCard
        footnote={
          s.p95DurationMs === null
            ? "no timing data"
            : `p95 ${formatDuration(s.p95DurationMs)}`
        }
        label="Avg duration"
        value={
          s.avgDurationMs === null
            ? "—"
            : formatDuration(Math.round(s.avgDurationMs))
        }
      />
      <AnalyticsKpiCard
        footnote={
          s.lastSeen ? `last seen ${formatRelativeTime(s.lastSeen)}` : undefined
        }
        label="Total runs"
        value={s.totalRuns.toLocaleString()}
      />
    </>
  );
}

/** Fallback for the KPI strip: four {@link KpiCardSkeleton}s. */
function KpiStripSkeleton() {
  return (
    <>
      <KpiCardSkeleton />
      <KpiCardSkeleton />
      <KpiCardSkeleton />
      <KpiCardSkeleton />
    </>
  );
}

/** Chart + recent-runs table — reads deferred `history` plus (for the "of N
 *  total runs" caption) `stats.totalRuns`. Reading both defers here means the
 *  region waits on the slower of the two; acceptable below-the-fold behind its
 *  own skeleton. */
function HistoryRegion({
  details,
  stats,
  base,
  file,
  teamSlug,
  projectSlug,
  testTitle,
}: {
  details: OkProps["details"];
  stats: OkProps["stats"];
  base: string;
  file: string;
  teamSlug: string;
  projectSlug: string;
  testTitle: string;
}) {
  const { history } = use(details);
  const { totalRuns } = use(stats);

  // Chart points + the visible-window pass/fail/flaky summary. The summary
  // reflects the "last N runs" the chart plots, not the all-time KPIs above.
  // `history` is loaded newest-first up to HISTORY_LIMIT (60), but the chart
  // only draws the most recent RUN_HISTORY_CHART_MAX_POINTS (30) — slice to the
  // same window so the title count and summary describe exactly what's drawn.
  const { points: historyPoints, stats: windowStats } = buildTestHistoryView(
    history.slice(0, RUN_HISTORY_CHART_MAX_POINTS),
    {
      base,
      teamSlug,
      projectSlug,
    },
  );

  return (
    <>
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
        subtitle={file}
        title={`Duration · last ${historyPoints.length} run${
          historyPoints.length === 1 ? "" : "s"
        } of this test`}
      />

      <Card className="overflow-hidden rounded-[9px]">
        <div className="border-b border-line-1 px-[18px] py-3">
          <h2 className="text-body font-semibold tracking-tight">
            Recent runs
          </h2>
          <p className="mt-0.5 text-caption text-fg-3">
            {history.length === totalRuns
              ? `All ${totalRuns.toLocaleString()} runs of this test.`
              : `Most recent ${history.length} of ${totalRuns.toLocaleString()} runs. Open a row for attempts, errors, and artifacts.`}
          </p>
        </div>
        <Table className="table-fixed">
          <RecentRunsTableHead />
          <TableBody>
            {history.map((h) => {
              const href = `${base}/runs/${h.runId}/tests/${h.testResultId}`;
              const shortId = h.runId.slice(-7);
              const message = firstLine(h.commitMessage);
              return (
                <TableRow key={h.testResultId}>
                  <TableCell className="w-10 px-4 py-3 align-middle">
                    <RowLink href={href}>
                      <span className="sr-only">
                        View {testTitle} in run #{shortId}
                      </span>
                      <StatusGlyph size={13} status={h.status} />
                    </RowLink>
                  </TableCell>
                  <TableCell className="px-4 py-3 align-middle">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-caption text-fg-3">
                        #{shortId}
                      </span>
                      {message ? (
                        <span
                          className="truncate text-body text-fg-1"
                          title={message}
                        >
                          {message}
                        </span>
                      ) : (
                        <span className="text-body text-fg-3">
                          {h.actor ?? "—"}
                        </span>
                      )}
                      {h.retryCount > 0 && (
                        <span className="shrink-0 font-mono text-micro text-fg-3">
                          {h.retryCount} retr
                          {h.retryCount === 1 ? "y" : "ies"}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="w-[220px] px-4 py-3 align-middle">
                    <span
                      className="block truncate font-mono text-caption text-fg-3"
                      title={h.branch ?? undefined}
                    >
                      {h.branch ?? "—"}
                      {h.commitSha ? ` · ${h.commitSha.slice(0, 7)}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="w-[110px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-1">
                    {formatDuration(h.durationMs)}
                  </TableCell>
                  <TableCell className="w-[110px] px-4 py-3 text-right align-middle text-caption text-fg-3">
                    {formatRelativeTime(h.createdAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

/** Shared 5-column head used by the live recent-runs table and its skeleton. */
function RecentRunsTableHead() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="w-10 px-4" />
        <TableHead className="px-4">Run</TableHead>
        <TableHead className="w-[220px] px-4">Branch</TableHead>
        <TableHead className="w-[110px] px-4 text-right">Duration</TableHead>
        <TableHead className="w-[110px] px-4 text-right">When</TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** Placeholder row count for {@link HistoryRegionSkeleton}'s table — the real
 *  count isn't known until the deferred reads resolve, so this is a guess. */
const HISTORY_SKELETON_ROWS = 8;

/**
 * Fallback for the chart + recent-runs region. Reuses {@link RunHistoryChart}'s
 * skeleton (same frame, `subtitle={file}`, height 120) and a matching 5-column
 * table shell so the swap moves nothing. Row count is a placeholder and the
 * chart title omits the run count (like the generic `title="Duration"`
 * skeletons on the run-detail / result-detail pages) — the real counts aren't
 * known until the deferred reads resolve.
 */
function HistoryRegionSkeleton({ subtitle }: { subtitle: string }) {
  return (
    <>
      <RunHistoryChartSkeleton subtitle={subtitle} title="Duration" />
      <Card className="overflow-hidden rounded-[9px]">
        <div className="border-b border-line-1 px-[18px] py-3">
          <h2 className="text-body font-semibold tracking-tight">
            Recent runs
          </h2>
          {/* Block wrapper (not <p>): Skeleton renders a <div>, which is invalid
           * phrasing content inside a <p> and triggers a hydration mismatch when
           * this skeleton streams. */}
          <div className="mt-0.5">
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <Table className="table-fixed">
          <RecentRunsTableHead />
          <TableBody>
            {Array.from({ length: HISTORY_SKELETON_ROWS }, (_, i) => (
              <TableRow key={i}>
                <TableCell className="w-10 px-4 py-3">
                  <Skeleton className="mx-auto size-[13px] rounded-full" />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                </TableCell>
                <TableCell className="w-[220px] px-4 py-3">
                  <Skeleton className="h-3 w-32" />
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3">
                  <Skeleton className="ml-auto h-3 w-14" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
