import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import {
  countMonitors,
  listMonitors,
  listRecentExecutionsByMonitor,
} from "@/lib/monitors/monitors-repo";
import { requireTenantContext } from "@/lib/tenant-context";
import { uptimeFromExecutions } from "./monitors-ui.shared";

export type Props = InferProps<typeof loader>;

/** How many recent executions feed each row's `ExecStrip` + 24h uptime. */
const RECENT_EXECUTION_WINDOW = 24;

/**
 * Monitors list loader. Active project comes from `middleware/01.context.ts`
 * via `requireTenantContext` (no extra membership join). Returns every monitor
 * in the project newest-first, each enriched with its recent execution states
 * (for the `ExecStrip` sparkline) and a derived 24h uptime, plus the project
 * count and the per-project cap. The page renders the roster, the status
 * summary strip, and the create-button hint; the create action on the
 * `monitors/[monitorId]` route (which also serves `/monitors/new`) is the hard
 * enforcer of the cap.
 *
 * One D1 round-trip for the monitors + count (concurrent), then one bounded
 * fan-out for the per-monitor execution windows (`listRecentExecutionsByMonitor`
 * runs ≤ cap small queries concurrently). Executions are projected down to the
 * minimal `{ state, runId, createdAt }` the page needs — the wire payload stays
 * small and the `ExecStrip` only reads `state`.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const [monitors, count] = await Promise.all([
    listMonitors(scope),
    countMonitors(scope),
  ]);

  const executionsByMonitor = await listRecentExecutionsByMonitor(
    scope,
    monitors.map((m) => m.id),
    RECENT_EXECUTION_WINDOW,
  );

  const enriched = monitors.map((m) => {
    const executions = (executionsByMonitor.get(m.id) ?? []).map((e) => ({
      state: e.state,
      runId: e.runId,
      createdAt: e.createdAt,
    }));
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      enabled: m.enabled,
      intervalSeconds: m.intervalSeconds,
      lastStatus: m.lastStatus,
      lastRunAt: m.lastRunAt,
      recentExecutions: executions,
      uptime: uptimeFromExecutions(executions),
    };
  });

  return {
    project: {
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      role: project.role,
    },
    monitors: enriched,
    count,
    limit: env.WRIGHTFUL_MONITOR_MAX_PER_PROJECT,
  };
});
