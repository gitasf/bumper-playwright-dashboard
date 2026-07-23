import { use } from "react";
import { DeferredSection } from "@/components/defer-error-boundary";
import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { Props, UsageRow, UsageRowTone } from "./usage.server";

const TONE_BAR: Record<UsageRowTone, string> = {
  ok: "bg-bg-3",
  warn: "bg-warning",
  over: "bg-fail",
};

function UsageMeter({ row }: { row: UsageRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-body text-fg-1">{row.label}</span>
        <span className="font-mono text-micro text-fg-3 tabular-nums">
          {row.usedLabel} / {row.limitLabel}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3"
        aria-hidden
      >
        {row.pct !== null && (
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300 ease-out-strong",
              TONE_BAR[row.tone],
            )}
            style={{ width: `${row.pct}%` }}
          />
        )}
      </div>
      {row.tone === "over" && (
        <span className="text-micro text-fail">
          Over the plan limit — new {row.label.toLowerCase()} are blocked until
          the next billing period.
        </span>
      )}
    </div>
  );
}

/** A single meter row's skeleton (label/limit line + bar) — the fallback
 *  shape for the deferred `testResults` row while its `count(*)` resolves. */
function UsageMeterSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Skeleton className="h-[13px] w-24" />
        <Skeleton className="h-[11px] w-20" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
  );
}

/**
 * Settings → Team → Usage. Read-only meter for the current billing period.
 * The header, card title, and the runs/artifact-storage meters (a cheap
 * single indexed query) paint immediately; only the "Test results" meter — the
 * heaviest read, a `count(*)` scan of a month of the fact table — streams in
 * behind its own small skeleton via `defer()`. Purely presentational — all
 * formatting/tone is computed in `usage.server.ts`.
 */
export default function SettingsTeamUsagePage({
  team,
  artifactCount,
  rows,
  testResults,
}: Props) {
  const [runsRow, artifactBytesRow] = rows;

  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · Usage`}
        subtitle="Usage for the current billing period, against your plan. Resets at the start of each month."
      />

      <SettingsCard title="This billing period">
        <div className="flex flex-col gap-5">
          {runsRow && <UsageMeter row={runsRow} />}
          <DeferredSection skeleton={<UsageMeterSkeleton />}>
            <TestResultsMeter testResults={testResults} />
          </DeferredSection>
          {artifactBytesRow && <UsageMeter row={artifactBytesRow} />}
          <p className="text-body text-fg-3 leading-relaxed">
            <span className="font-mono tabular-nums">
              {artifactCount.toLocaleString("en-US")}
            </span>{" "}
            artifacts stored this period.
          </p>
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}

/** Reads the deferred `testResults` row and renders it as a normal meter. */
function TestResultsMeter({
  testResults,
}: {
  testResults: Props["testResults"];
}) {
  const row = use(testResults);
  return <UsageMeter row={row} />;
}
