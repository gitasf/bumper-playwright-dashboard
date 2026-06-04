import { Link } from "@void/react";
import type { ArtifactAction } from "@/components/artifact-actions";
import { ArtifactsRail } from "@/components/artifacts-rail";
import {
  AttemptPanel,
  AttemptTabsBar,
  type AttemptTabItem,
} from "@/components/attempt-tabs";
import {
  RunHistoryChart,
  type RunHistoryPoint,
} from "@/components/run-history-chart";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { TestErrorAlert } from "@/components/test-error-alert";
import {
  signedDownloadHref,
  signedTraceViewerUrl,
} from "@/lib/artifact-tokens";
import { parseTitleSegments } from "@/lib/group-tests-by-file";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./index.server";

interface Artifact {
  id: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  attempt: number;
  r2Key: string;
  role: string | null;
  snapshotName: string | null;
}

// Order within an attempt: trace first (most useful for debugging), then
// visual diff (groups three images into one entry), video, screenshot,
// everything else. `other` covers error-context etc.
const TYPE_ORDER: Record<string, number> = {
  trace: 0,
  visual: 1,
  video: 2,
  screenshot: 3,
  other: 4,
};

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
 * artifacts rail on the right, history strip + tags/annotations across
 * the top. The loader returns either `kind: "ok"` (full data) or
 * `kind: "not_found"` (testResult or run row missing) so this component
 * doesn't have to do its own existence gating.
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
    tags: tagRows,
    annotations: annotationRows,
    artifacts: artifactRows,
    attempts: attemptRows,
    history: historyRows,
    artifactTokens,
    origin,
  } = props;

  const base = `/t/${project.teamSlug}/p/${project.projectSlug}`;

  const artifactsByAttempt = new Map<number, Artifact[]>();
  for (const a of artifactRows) {
    const bucket = artifactsByAttempt.get(a.attempt) ?? [];
    bucket.push(a);
    artifactsByAttempt.set(a.attempt, bucket);
  }
  for (const bucket of artifactsByAttempt.values()) {
    bucket.sort((x, y) => {
      const dx = TYPE_ORDER[x.type] ?? 99;
      const dy = TYPE_ORDER[y.type] ?? 99;
      if (dx !== dy) return dx - dy;
      return x.name.localeCompare(y.name);
    });
  }

  const maxObservedAttempt =
    artifactRows.length > 0
      ? Math.max(...artifactRows.map((a) => a.attempt))
      : -1;
  const totalAttempts =
    attemptRows.length > 0
      ? attemptRows.length
      : Math.max(result.retryCount + 1, maxObservedAttempt + 1);

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

  const downloadHref = (artifactId: string): string =>
    signedDownloadHref(artifactId, artifactTokens[artifactId] ?? "");

  const allAttempts = Array.from({ length: totalAttempts }, (_, i) => i);
  const fallbackErrorOn: number | null =
    attemptRows.length === 0
      ? result.status === "failed" || result.status === "timedout"
        ? totalAttempts - 1
        : result.status === "flaky"
          ? 0
          : null
      : null;

  const toAction = (a: Artifact): ArtifactAction => ({
    id: a.id,
    type: a.type,
    name: a.name,
    contentType: a.contentType,
    downloadHref: downloadHref(a.id),
    traceViewerUrl:
      a.type === "trace"
        ? signedTraceViewerUrl(origin, a.id, artifactTokens[a.id] ?? "")
        : undefined,
  });

  const toVisualAction = (rows: Artifact[]): ArtifactAction => {
    const first = rows[0];
    const byRole = new Map(rows.map((r) => [r.role, r] as const));
    const frame = (
      role: "expected" | "actual" | "diff",
    ): { href: string; name: string } | null => {
      const r = byRole.get(role);
      return r ? { href: downloadHref(r.id), name: r.name } : null;
    };
    return {
      id: `visual::${first.attempt}::${first.snapshotName}`,
      type: "visual",
      name: first.snapshotName ?? "snapshot",
      contentType: "image/png",
      downloadHref: frame("diff")?.href ?? frame("actual")?.href ?? "",
      visualGroup: {
        snapshotName: first.snapshotName ?? "snapshot",
        expected: frame("expected"),
        actual: frame("actual"),
        diff: frame("diff"),
      },
    };
  };
  const defaultTab = String(totalAttempts - 1);

  const { testTitle } = parseTitleSegments(
    result.title,
    result.file,
    result.projectName,
  );
  const reproduceCommand = `npx playwright test ${JSON.stringify(
    result.file,
  )} --grep ${JSON.stringify(testTitle)}`;

  const chronologicalHistory = [...historyRows].reverse();
  const historyPoints: RunHistoryPoint[] = chronologicalHistory.map((h) => ({
    id: h.testResultId,
    durationMs: h.durationMs,
    status: h.status,
    current: h.testResultId === testResultId,
    href:
      h.testResultId === testResultId
        ? undefined
        : `${base}/runs/${h.runId}/tests/${h.testResultId}`,
    hover:
      h.testResultId === testResultId
        ? undefined
        : {
            kind: "testResult" as const,
            teamSlug: project.teamSlug,
            projectSlug: project.projectSlug,
            runId: h.runId,
            testResultId: h.testResultId,
          },
    label: [
      h.status,
      formatDuration(h.durationMs),
      formatRelativeTime(h.createdAt),
      h.branch,
      h.commitSha ? h.commitSha.slice(0, 7) : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  const historyStats = (() => {
    const ran = chronologicalHistory.filter(
      (h) => h.status !== "skipped",
    ).length;
    const failed = chronologicalHistory.filter(
      (h) => h.status === "failed" || h.status === "timedout",
    ).length;
    const flakyCount = chronologicalHistory.filter(
      (h) => h.status === "flaky",
    ).length;
    const passPct =
      ran === 0 ? 100 : Math.round(((ran - failed - flakyCount) / ran) * 100);
    return { ran, failed, flakyCount, passPct };
  })();

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
      <div className="border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Link
            href={`${base}/runs/${runId}`}
            className="hover:text-foreground transition-colors"
          >
            &larr; Back to run
          </Link>
        </div>
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <StatusBadge status={result.status} />
          <h1 className="font-semibold text-xl">{testTitle}</h1>
        </div>
        <div className="font-mono text-muted-foreground text-xs">
          {result.file}
          {result.projectName ? ` · ${result.projectName}` : ""} ·{" "}
          {formatDuration(result.durationMs)}
          {result.retryCount > 0 ? ` · ${result.retryCount} retries` : ""}
        </div>
        {(tagRows.length > 0 || annotationRows.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
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
        <RunHistoryChart
          points={historyPoints}
          title={`Duration · last ${historyPoints.length} run${historyPoints.length === 1 ? "" : "s"} of this test`}
          subtitle={result.file}
          rightSlot={
            historyPoints.length > 1 ? (
              <>
                <span>pass {historyStats.passPct}%</span>
                <span style={{ color: "var(--color-destructive)" }}>
                  × {historyStats.failed}
                </span>
                <span style={{ color: "var(--color-warning)" }}>
                  ⚠ {historyStats.flakyCount}
                </span>
              </>
            ) : null
          }
          emptyState="No prior runs recorded for this test yet."
        />
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
          {allAttempts.map((attempt) => {
            const group = artifactsByAttempt.get(attempt) ?? [];
            const copyPromptRaw = group.find((a) => a.type === "other");
            const nonVisualActions: ArtifactAction[] = group
              .filter((a) => a.type !== "other" && a.type !== "visual")
              .map(toAction);
            const visualByName = new Map<string, Artifact[]>();
            for (const a of group) {
              if (a.type !== "visual" || !a.snapshotName) continue;
              const bucket = visualByName.get(a.snapshotName) ?? [];
              bucket.push(a);
              visualByName.set(a.snapshotName, bucket);
            }
            const visualActions: ArtifactAction[] = Array.from(
              visualByName.values(),
            ).map(toVisualAction);
            const mediaActions: ArtifactAction[] = [
              ...nonVisualActions,
              ...visualActions,
            ].sort((x, y) => {
              const dx = TYPE_ORDER[x.type] ?? 99;
              const dy = TYPE_ORDER[y.type] ?? 99;
              if (dx !== dy) return dx - dy;
              return x.name.localeCompare(y.name);
            });
            return (
              <AttemptPanel
                key={attempt}
                value={String(attempt)}
                values={tabValues}
                defaultValue={defaultTab}
              >
                <ArtifactsRail
                  media={mediaActions}
                  copyPrompt={copyPromptRaw ? toAction(copyPromptRaw) : null}
                  reproduceCommand={reproduceCommand}
                  environment={{
                    browser: result.projectName,
                    workerIndex: result.workerIndex,
                    playwrightVersion: run.playwrightVersion,
                  }}
                />
              </AttemptPanel>
            );
          })}
        </aside>
      </div>
    </div>
  );
}
