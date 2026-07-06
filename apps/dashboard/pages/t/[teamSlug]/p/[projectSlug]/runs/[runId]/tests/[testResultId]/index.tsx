import { Link, PREFETCH_REALTIME } from "@/components/ui/link";
import { use } from "react";
import {
  ArtifactsRail,
  type EnvironmentFields,
} from "@/components/artifacts-rail";
import {
  AttemptPanel,
  AttemptTabsBar,
  type AttemptTabItem,
} from "@/components/attempt-tabs";
import { DeferredSection } from "@/components/defer-error-boundary";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { QuarantineControl } from "@/components/quarantine-control";
import {
  RunHistoryChart,
  RunHistoryChartSkeleton,
} from "@/components/run-history-chart";
import { StatusBadge } from "@/components/status-badge";
import { TestErrorAlert } from "@/components/test-error-alert";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { parseTitleSegments } from "@/lib/group-tests-by-file";
import type { AttemptArtifactGroup } from "@/lib/test-artifact-actions";
import { buildTestHistoryView } from "@/lib/test-history-view";
import { formatDuration } from "@/lib/time-format";
import type { Props } from "./index.server";

/** The loader's success shape — carries the deferred `history` + `artifacts`. */
type OkProps = Extract<Props, { kind: "ok" }>;

function attemptLabel(attempt: number, totalAttempts: number): string {
  if (totalAttempts === 1) return "only attempt";
  if (attempt === 0) return "initial";
  if (attempt === totalAttempts - 1) return "final attempt";
  return `retry ${attempt}`;
}

type AttemptRowStatus = "passed" | "failed" | "skipped";
function normaliseAttemptRowStatus(status: string): AttemptRowStatus {
  if (status === "passed") return "passed";
  if (status === "skipped") return "skipped";
  return "failed";
}

/**
 * Test detail page. Single-spec deep dive: attempts tabs on the left,
 * artifacts rail on the right, history strip + tags/annotations across the top.
 * The loader returns either `kind: "ok"` (full data) or `kind: "not_found"`.
 *
 * The header, metadata, attempt tabs and error panels paint immediately; the
 * two costly reads stream in behind skeletons via `defer()`: the duration
 * history strip and the per-attempt artifact rail (the token-signing fan-out).
 */
export default function TestDetailPage(props: Props) {
  if (props.kind === "not_found") {
    const { project, runId } = props;
    const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;
    return (
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <h1 className="mb-2 font-semibold text-2xl">Test not found</h1>
        <Link
          href={`${base}/runs/${runId}`}
          className="text-foreground underline-offset-4 hover:underline"
        >
          Back to run
        </Link>
      </div>
    );
  }

  const {
    project,
    runId,
    testResultId,
    result,
    run,
    quarantine,
    quarantineRedirectTo,
    quarantineError,
    tags: tagRows,
    annotations: annotationRows,
    attempts: attemptRows,
    history,
    artifacts,
  } = props;

  const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;
  const quarantineActionPath = `/api/t/${project.teamSlug}/p/${project.projectSlug}/quarantine`;

  // Attempt count from the eager per-attempt rows; the fallback trusts the
  // reporter's `retryCount + 1`. (Formerly also `max`'d with an artifact-derived
  // `maxObservedAttempt`, but that now streams in the deferred rail — the eager
  // tab scaffold must not read it, or the whole left column would suspend.)
  const totalAttempts =
    attemptRows.length > 0 ? attemptRows.length : result.retryCount + 1;

  const attemptsByIndex = new Map<
    number,
    {
      status: string;
      errorMessage: string | null;
      errorStack: string | null;
    }
  >();
  for (const row of attemptRows) {
    attemptsByIndex.set(row.attempt, {
      status: row.status,
      errorMessage: row.errorMessage,
      errorStack: row.errorStack,
    });
  }

  const allAttempts = Array.from({ length: totalAttempts }, (_, i) => i);
  // Which attempt carries the error when there are no per-attempt rows to fall
  // back on — a per-attempt render concern kept local to this page.
  const fallbackErrorOn: number | null =
    attemptRows.length === 0
      ? result.status === "failed" || result.status === "timedout"
        ? totalAttempts - 1
        : result.status === "flaky"
          ? 0
          : null
      : null;
  const defaultTab = String(totalAttempts - 1);

  const { testTitle } = parseTitleSegments(
    result.title,
    result.file,
    result.projectName,
  );
  const reproduceCommand = `npx playwright test ${JSON.stringify(
    result.file,
  )} --grep ${JSON.stringify(testTitle)}`;

  const tabValues = allAttempts.map((a) => String(a));
  const resolveAttemptView = (attempt: number) => {
    const row = attemptsByIndex.get(attempt);
    if (row) {
      return {
        status: normaliseAttemptRowStatus(row.status),
        errorMessage: row.errorMessage,
        errorStack: row.errorStack,
      };
    }
    const finalStatus = result.status;
    const inferred: AttemptRowStatus =
      finalStatus === "skipped"
        ? "skipped"
        : finalStatus === "passed"
          ? "passed"
          : finalStatus === "flaky"
            ? attempt === totalAttempts - 1
              ? "passed"
              : "failed"
            : "failed";
    const isErrorOn = fallbackErrorOn === attempt;
    return {
      status: inferred,
      errorMessage: isErrorOn ? result.errorMessage : null,
      errorStack: isErrorOn ? result.errorStack : null,
    };
  };
  const tabItems: AttemptTabItem[] = allAttempts.map((attempt) => ({
    value: String(attempt),
    status: resolveAttemptView(attempt).status,
    label: `Attempt ${attempt + 1}`,
    finalSuffix:
      attempt === totalAttempts - 1 && totalAttempts > 1 ? "(Final)" : null,
  }));

  return (
    <div className="flex flex-col">
      <DetailHeaderBar className="justify-between gap-4 border-b border-border">
        <div className="flex min-w-0 items-center gap-3">
          <HeaderCrumbs
            items={[
              { label: "Runs", href: base, cacheFor: PREFETCH_REALTIME },
              {
                label: `#${runId.slice(-7)}`,
                href: `${base}/runs/${runId}`,
                cacheFor: PREFETCH_REALTIME,
              },
            ]}
          />
          <StatusBadge status={result.status} />
          <h1 className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.2px]">
            {testTitle}
          </h1>
        </div>
        <QuarantineControl
          actionPath={quarantineActionPath}
          canManage={project.canManageQuarantine}
          quarantine={quarantine}
          redirectTo={quarantineRedirectTo}
          testId={result.testId}
          title={testTitle}
        />
      </DetailHeaderBar>

      {/* Metadata + tags/annotations, below the title bar. */}
      <div className="shrink-0 border-b border-border px-6 pt-3 pb-3">
        <div className="font-mono text-muted-foreground text-xs">
          {result.file}
          {result.projectName ? ` · ${result.projectName}` : ""} ·{" "}
          {formatDuration(result.durationMs)}
          {result.retryCount > 0 ? ` · ${result.retryCount} retries` : ""}
        </div>
        {quarantineError && (
          <Alert className="mt-3" variant="error">
            <AlertDescription>{quarantineError}</AlertDescription>
          </Alert>
        )}
        {(tagRows.length > 0 || annotationRows.length > 0) && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {tagRows.map((t, i) => (
              <Badge key={`tag-${i}`} variant="info" size="sm">
                {t.tag}
              </Badge>
            ))}
            {annotationRows.map((a, i) => (
              <Badge
                key={`ann-${i}`}
                variant="warning"
                size="sm"
                title={a.description ?? undefined}
              >
                {a.type}
                {a.description ? `: ${a.description}` : ""}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="px-6 pt-4 pb-2 shrink-0">
        <DeferredSection
          resetKey={testResultId}
          skeleton={
            <RunHistoryChartSkeleton subtitle={result.file} title="Duration" />
          }
        >
          <HistoryChartRegion
            base={base}
            file={result.file}
            history={history}
            projectSlug={project.projectSlug}
            teamSlug={project.teamSlug}
            testResultId={testResultId}
          />
        </DeferredSection>
      </div>

      <div className="flex flex-row gap-0">
        <section className="flex-[3] min-w-0 flex flex-col border-r border-border bg-background">
          {totalAttempts > 1 ? (
            <div className="shrink-0 border-b border-border px-3 pt-2">
              <AttemptTabsBar items={tabItems} defaultValue={defaultTab} />
            </div>
          ) : null}
          <div>
            {allAttempts.map((attempt) => {
              const view = resolveAttemptView(attempt);
              return (
                <AttemptPanel
                  key={attempt}
                  value={String(attempt)}
                  values={tabValues}
                  defaultValue={defaultTab}
                  className="p-5"
                >
                  {view.errorMessage ? (
                    <TestErrorAlert
                      errorMessage={view.errorMessage}
                      errorStack={view.errorStack}
                    />
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {attemptLabel(attempt, totalAttempts) === "only attempt"
                        ? "No error details recorded."
                        : `No error details recorded for this attempt (${attemptLabel(attempt, totalAttempts)}).`}
                    </p>
                  )}
                </AttemptPanel>
              );
            })}
          </div>
        </section>
        <aside className="w-[320px] shrink-0 bg-muted/10">
          <DeferredSection
            resetKey={testResultId}
            skeleton={<ArtifactsRailSkeleton />}
          >
            <TestArtifactsRail
              allAttempts={allAttempts}
              artifacts={artifacts}
              defaultTab={defaultTab}
              environment={{
                browser: result.projectName,
                workerIndex: result.workerIndex,
                playwrightVersion: run.playwrightVersion,
              }}
              reproduceCommand={reproduceCommand}
              tabValues={tabValues}
            />
          </DeferredSection>
        </aside>
      </div>
    </div>
  );
}

/** Deferred per-test duration history strip. Reads the bounded `history` scan
 *  via `use()` and builds the chart view here (buildTestHistoryView is pure).
 *  The skeleton passes the same eager `subtitle` (file) + a stable title, so
 *  the shared RunHistoryChartFrame title row is identical across the swap. */
function HistoryChartRegion({
  history,
  base,
  teamSlug,
  projectSlug,
  testResultId,
  file,
}: {
  history: OkProps["history"];
  base: string;
  teamSlug: string;
  projectSlug: string;
  testResultId: string;
  file: string;
}) {
  const historyRows = use(history);
  const { points: historyPoints, stats: historyStats } = buildTestHistoryView(
    historyRows,
    { base, teamSlug, projectSlug, currentTestResultId: testResultId },
  );
  return (
    <RunHistoryChart
      points={historyPoints}
      title={`Duration · last ${historyPoints.length} run${historyPoints.length === 1 ? "" : "s"} of this test`}
      subtitle={file}
      rightSlot={
        historyPoints.length > 1 ? (
          <>
            <span>pass {historyStats.passPct}%</span>
            <span style={{ color: "var(--color-destructive)" }}>
              × {historyStats.failed}
            </span>
            <span style={{ color: "var(--color-warning)" }}>
              ⚠ {historyStats.flaky}
            </span>
          </>
        ) : null
      }
      emptyState="No prior runs recorded for this test yet."
    />
  );
}

/** Deferred per-attempt artifact rail (right column). Reads the artifact
 *  fan-out via `use()`; the active-attempt panel is chosen off the `?attempt=`
 *  URL param, exactly like the eager left column, so the Suspense boundary
 *  between them is invisible. Reproduction + environment are eager-derived and
 *  passed in. */
function TestArtifactsRail({
  artifacts,
  allAttempts,
  tabValues,
  defaultTab,
  reproduceCommand,
  environment,
}: {
  artifacts: OkProps["artifacts"];
  allAttempts: number[];
  tabValues: string[];
  defaultTab: string;
  reproduceCommand: string;
  environment: EnvironmentFields;
}) {
  const { artifactGroups } = use(artifacts);
  const groupsByAttempt = new Map<number, AttemptArtifactGroup>(
    artifactGroups.map((g) => [g.attempt, g] as const),
  );
  return (
    <>
      {allAttempts.map((attempt) => {
        const group = groupsByAttempt.get(attempt);
        return (
          <AttemptPanel
            key={attempt}
            value={String(attempt)}
            values={tabValues}
            defaultValue={defaultTab}
          >
            <ArtifactsRail
              media={group?.media ?? []}
              copyPrompt={group?.copyPrompt ?? null}
              reproduceCommand={reproduceCommand}
              environment={environment}
            />
          </AttemptPanel>
        );
      })}
    </>
  );
}

/** Fallback for the artifact rail — mirrors its three sections (media buttons /
 *  reproduction block / environment rows). The aside sits beside the taller
 *  error column and is the terminal region, so its resolved height doesn't
 *  shift anything else. */
function ArtifactsRailSkeleton() {
  return (
    <div className="flex flex-col">
      <section className="p-5 border-b border-border">
        <Skeleton className="mb-3 h-2.5 w-16" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </section>
      <section className="p-5 border-b border-border">
        <Skeleton className="mb-3 h-2.5 w-20" />
        <Skeleton className="h-[68px] w-full rounded-md" />
      </section>
      <section className="p-5">
        <Skeleton className="mb-3 h-2.5 w-20" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </section>
    </div>
  );
}
