import { defineHandler, type InferProps } from "void";
import {
  countMonitors,
  listMonitors,
  listRecentExecutionsByMonitor,
} from "@/lib/monitors/monitors-repo";
import { requireTenantContext } from "@/lib/tenant-context";
import {
  RECENT_EXECUTION_WINDOW,
  uptimeFromExecutions,
} from "./monitors-ui.shared";

export type Props = InferProps<typeof loader>;

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
 * One round-trip for the monitors + count (concurrent), then one more for the
 * per-monitor execution windows (`listRecentExecutionsByMonitor` — a single
 * ranked query over all monitor ids, not a per-monitor fan-out). Executions are
 * projected down to the minimal `{ state, runId, createdAt }` the page needs —
 * the wire payload stays small and the `ExecStrip` only reads `state`.
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
    // `id` rides along so the live reducer can dedupe a redelivered settle and
    // React can key the strip; `ExecStrip` itself only reads `state`. The
    // projection mirrors the realtime `MonitorExecutionRow` exactly (incl.
    // `durationMs` / `statusCode`) so a folded-in live settle and an SSR-seeded
    // row share one shape — and http response-time / status are available to the
    // strip for free.
    const executions = (executionsByMonitor.get(m.id) ?? []).map((e) => ({
      id: e.id,
      state: e.state,
      runId: e.runId,
      createdAt: e.createdAt,
      durationMs: e.durationMs,
      statusCode: e.statusCode,
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
      // `id` is the `void/ws` room key the list island subscribes against.
      id: project.id,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      role: project.role,
    },
    monitors: enriched,
    // Total across both types. Browser + http have separate caps enforced at
    // create time (see `createMonitor`); the roster just shows the total.
    count,
  };
});
