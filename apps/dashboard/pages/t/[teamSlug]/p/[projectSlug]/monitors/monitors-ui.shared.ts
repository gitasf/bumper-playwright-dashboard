import { MONITOR_INTERVAL_PRESETS } from "@/lib/monitors/monitor-schemas";

/**
 * Presentation helpers shared by the monitors list + detail pages. Kept in a
 * `.shared.ts` (no JSX, no `void/*` imports) so both the server-rendered list
 * and the detail page import the same humanizers — the interval labels here and
 * in the create form's `<select>` must agree, so they derive from the same
 * `MONITOR_INTERVAL_PRESETS` source of truth.
 */

/** Human label for a monitor interval: `1m`, `5m`, `30m`, `1h`. */
export function humanizeInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * 24h-style uptime % from a window of recent executions: passes ÷ countable
 * executions × 100. Mirrors the design — `running` (not finished) and `error`
 * (infra couldn't run the check, not an app outage) are excluded from the
 * denominator so an `error` doesn't read as downtime. Returns null when there's
 * nothing countable yet.
 */
export function uptimeFromExecutions(
  executions: ReadonlyArray<{ state: string }>,
): number | null {
  const countable = executions.filter(
    (e) => e.state !== "running" && e.state !== "error",
  );
  if (countable.length === 0) return null;
  const passes = countable.filter((e) => e.state === "pass").length;
  return (passes / countable.length) * 100;
}

/** `{ value, label }` options for the interval `<select>`, in preset order. */
export const INTERVAL_OPTIONS = MONITOR_INTERVAL_PRESETS.map((seconds) => ({
  value: seconds,
  label: `Every ${humanizeInterval(seconds)}`,
}));

/**
 * The Badge variant + dot tint for a monitor / execution status. `lastStatus`
 * and `MonitorExecution.state` share this vocabulary (pass | degraded | fail |
 * error | running | queued), so one mapping serves both surfaces. `degraded`
 * borrows the warning tone, `error`/`fail` the destructive one, `running` info.
 */
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

export function statusTone(status: string | null): StatusTone {
  switch (status) {
    case "pass":
      return "success";
    case "degraded":
      return "warning";
    case "fail":
    case "error":
      return "error";
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

/** Maps a {@link StatusTone} to the `ui/badge` variant prop. */
export function toneToBadgeVariant(
  tone: StatusTone,
): "success" | "warning" | "error" | "info" | "secondary" {
  return tone === "neutral" ? "secondary" : tone;
}
