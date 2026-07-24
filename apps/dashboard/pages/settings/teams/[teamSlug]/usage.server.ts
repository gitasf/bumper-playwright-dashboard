import { defer, defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { countTeamTestResults, formatBytes, loadTeamUsage } from "@/lib/usage";
import { requireRoleScope } from "@/lib/settings-scope";

export type UsageRowTone = "ok" | "warn" | "over";

export interface UsageRow {
  key: "runs" | "testResults" | "artifactBytes";
  label: string;
  usedLabel: string;
  limitLabel: string;
  /** 0–100, capped — drives the bar width. `null` when the limit is unlimited. */
  pct: number | null;
  tone: UsageRowTone;
}

export type Props = InferProps<typeof loader>;

/** 0–100 (capped) + tone classification for `used` against `limit`, shared by
 *  the eager runs/artifact rows and the deferred testResults row so both use
 *  the exact same threshold math. */
function buildUsageRow(
  key: UsageRow["key"],
  label: string,
  used: number,
  limit: number,
  fmt: (n: number) => string,
  warnPct: number,
): UsageRow {
  if (!Number.isFinite(limit)) {
    return {
      key,
      label,
      usedLabel: fmt(used),
      limitLabel: "Unlimited",
      pct: null,
      tone: "ok",
    };
  }
  const rawPct = limit > 0 ? (used / limit) * 100 : 100;
  const pct = Math.min(100, Math.round(rawPct));
  const tone: UsageRowTone =
    rawPct >= 100 ? "over" : rawPct >= warnPct ? "warn" : "ok";
  return {
    key,
    label,
    usedLabel: fmt(used),
    limitLabel: fmt(limit),
    pct,
    tone,
  };
}

const fmtNum = (n: number) => n.toLocaleString("en-US");

/**
 * Settings → Team → Usage. Current billing-period meter (runs, test results,
 * artifact storage) against the team's tier limits. Gated on `viewSettings`
 * (owner + member); a viewer 404s, same as every other settings page.
 *
 * All display formatting (byte units, percentages, tone) is computed here in the
 * server-only loader so the page component stays purely presentational and free
 * of the `@/lib/usage` import graph (which pulls in `db`/`env`).
 *
 * Plain `defineHandler` (not `withValidator`) — REQUIRED for `defer()`:
 * `withValidator` awaits/serializes the handler return, collapsing a `Deferred`
 * prop into a plain object so the client's `use()` throws. No `void/client#fetch`
 * caller consumes this loader's query shape.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireRoleScope(c, "viewSettings");

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const warnPct = env.WRIGHTFUL_QUOTA_SOFT_WARN_PCT;

  // Cheap — one indexed teams⋈usageCounters row (no fact-table scan) — so
  // awaited directly: the runs + artifact-storage meters paint on first render.
  const usage = await loadTeamUsage(team.id, nowSeconds);

  return {
    team,
    tier: usage.tier,
    periodStart: usage.periodStart,
    artifactCount: usage.artifactCount,
    rows: [
      buildUsageRow(
        "runs",
        "Runs",
        usage.runsCount,
        usage.limits.runs,
        fmtNum,
        warnPct,
      ),
      buildUsageRow(
        "artifactBytes",
        "Artifact storage",
        usage.artifactBytes,
        usage.limits.artifactBytes,
        formatBytes,
        warnPct,
      ),
    ],

    // Heaviest read — a `count(*)` over a month of the `testResults` fact table
    // (no live counter for this dimension; see `@/lib/usage`) — streams behind
    // its own skeleton so it never gates the meters above. Display-only, so
    // deferring can't tear against a form's rewritten response.
    testResults: defer(async (): Promise<UsageRow> => {
      const count = await countTeamTestResults(team.id, usage.periodStart);
      return buildUsageRow(
        "testResults",
        "Test results",
        count,
        usage.limits.testResults,
        fmtNum,
        warnPct,
      );
    }),
  };
});
