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
  ok: "bg-accent",
  warn: "bg-warning",
  over: "bg-fail",
};

function UsageMeter({ row }: { row: UsageRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-[length:var(--text-fs-13)] text-fg-1">
          {row.label}
        </span>
        <span className="font-mono text-[11px] text-fg-3 tabular-nums">
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
              "h-full rounded-full transition-all",
              TONE_BAR[row.tone],
            )}
            style={{ width: `${row.pct}%` }}
          />
        )}
      </div>
      {row.tone === "over" && (
        <span className="text-[11px] text-fail">
          Over the plan limit — new {row.label.toLowerCase()} are blocked until
          the next billing period.
        </span>
      )}
    </div>
  );
}

/**
 * Settings → Team → Usage. Read-only meter for the current billing period. The
 * header + "This billing period" card title paint immediately; the whole
 * billing-period aggregate (tier, period, meter rows, artifact count) streams
 * in behind a skeleton. Purely presentational — all formatting/tone is computed
 * in `usage.server.ts`.
 */
export default function SettingsTeamUsagePage({ team, usage }: Props) {
  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · Usage`}
        subtitle="Usage for the current billing period, against your plan. Resets at the start of each month."
      />

      <SettingsCard title="This billing period">
        <DeferredSection skeleton={<UsageMetersSkeleton />}>
          <UsageMetersRegion usage={usage} />
        </DeferredSection>
      </SettingsCard>
    </SettingsPage>
  );
}

/** The meter rows + "N artifacts stored" line. Reads the deferred `usage`
 *  group ({ tier, periodStart, artifactCount, rows }). */
function UsageMetersRegion({ usage }: { usage: Props["usage"] }) {
  const { artifactCount, rows } = use(usage);

  return (
    <div className="flex flex-col gap-5">
      {rows.map((row) => (
        <UsageMeter key={row.key} row={row} />
      ))}
      <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
        <span className="font-mono tabular-nums">
          {artifactCount.toLocaleString("en-US")}
        </span>{" "}
        artifacts stored this period.
      </p>
    </div>
  );
}

/** Fallback matching the meter region: three meter rows (label/limit line +
 *  bar) plus the trailing "N artifacts stored" text line, so the card holds
 *  its height and doesn't shift when the deferred usage resolves. */
function UsageMetersSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <Skeleton className="h-[13px] w-24" />
            <Skeleton className="h-[11px] w-20" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      ))}
      <Skeleton className="h-[13px] w-48" />
    </div>
  );
}
