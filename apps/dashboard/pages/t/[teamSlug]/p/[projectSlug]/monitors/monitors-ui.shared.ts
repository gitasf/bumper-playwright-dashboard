import {
  HTTP_INTERVAL_PRESETS_V1,
  MONITOR_INTERVAL_PRESETS,
} from "@/lib/monitors/monitor-schemas";

/**
 * Presentation helpers shared by the monitors list + detail pages. Kept in a
 * `.shared.ts` (no JSX, no `void/*` imports) so both the server-rendered list
 * and the detail page import the same humanizers — the interval labels here and
 * in the create form's `<select>` must agree, so they derive from the same
 * `MONITOR_INTERVAL_PRESETS` source of truth.
 */

/**
 * How many recent executions feed a monitor row's `ExecStrip` sparkline + 24h
 * uptime. Shared by the list loader (the window it fetches per monitor) and the
 * live reducer (`applyMonitorFeedEvent`, the cap it trims the strip back to as
 * fresh executions stream in) so the two never drift.
 */
export const RECENT_EXECUTION_WINDOW = 24;

/**
 * The default Playwright spec seeded into a freshly-created monitor's editor.
 * A minimal, runnable smoke check the user edits to point at their own flow —
 * concrete enough to run as-is, simple enough to read at a glance.
 *
 * Lives in this leaf `.shared.ts` (not `monitor-form.tsx`) so the monitors LIST
 * page can render it in its empty state WITHOUT importing the form — which would
 * drag the heavy CodeMirror editor bundle onto a page that never edits anything.
 */
export const DEFAULT_MONITOR_SPEC = `import { test, expect } from "@playwright/test";

test("homepage loads", async ({ page }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example/);
});
`;

/** Short label for a monitor type, in the product's vocabulary. */
export function monitorTypeLabel(type: string): string {
  switch (type) {
    case "http":
      return "uptime";
    case "tcp":
      return "TCP";
    case "ping":
      return "ping";
    default:
      return "browser";
  }
}

/** Human label for a monitor interval: `1m`, `5m`, `30m`, `1h`. */
export function humanizeInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Uptime % from a window of recent executions: "up" ÷ countable × 100. Both
 * `pass` AND `degraded` count as UP (Checkly's model — degraded is
 * available-but-slow, not downtime). `running` (not finished) and `error` (infra
 * couldn't run the check, not an app outage) are excluded from the denominator
 * so neither reads as downtime. Returns null when there's nothing countable yet.
 */
export function uptimeFromExecutions(
  executions: ReadonlyArray<{ state: string }>,
): number | null {
  const countable = executions.filter(
    (e) => e.state !== "running" && e.state !== "error",
  );
  if (countable.length === 0) return null;
  const up = countable.filter(
    (e) => e.state === "pass" || e.state === "degraded",
  ).length;
  return (up / countable.length) * 100;
}

/** `{ value, label }` options for the browser interval `<select>`, preset order. */
export const INTERVAL_OPTIONS = MONITOR_INTERVAL_PRESETS.map((seconds) => ({
  value: seconds,
  label: `Every ${humanizeInterval(seconds)}`,
}));

/**
 * Interval options for the HTTP (uptime) form. The v1 subset (`>= 60s`) only —
 * sub-minute cadences are a later scheduling phase, so they're not offered yet
 * even though the schema would accept them.
 */
export const HTTP_INTERVAL_OPTIONS = HTTP_INTERVAL_PRESETS_V1.map(
  (seconds) => ({
    value: seconds,
    label: `Every ${humanizeInterval(seconds)}`,
  }),
);

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
