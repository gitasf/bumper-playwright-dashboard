import type { RunOriginFilter } from "@/lib/runs/filters";
import type { ProjectFeedEvent, RunListRowData } from "@/realtime/events";

/** The slice of the list's view state the feed reducer needs. */
export interface ProjectFeedView {
  /** False on filtered/paginated views — `run-created` is ignored outright. */
  acceptNewRuns: boolean;
  /** The active origin view; a created run must match it to be prepended. */
  origin: RunOriginFilter;
}

/**
 * Whether a run of `origin` belongs in the given origin view. The server
 * broadcasts `run-created` for ALL runs (synthetic included) and the CLIENT
 * applies the view policy here: `"ci"` accepts only ci, `"synthetic"` only
 * synthetic, `"all"` both.
 */
function originMatchesView(origin: string, view: RunOriginFilter): boolean {
  return view === "all" ? true : origin === view;
}

/**
 * Pure reducer folding one project-feed event into the runs-list rows, used by
 * the WS project-room hook (`useProjectRoom`) so the merge rules are
 * unit-testable without React or a live connection.
 *
 * Rules:
 *   - `run-progress`: overlay the summary onto the matching row IN PLACE; a row
 *     not currently displayed is ignored (its update has nowhere to land — the
 *     SSR seed / next load is authoritative). Returns the same array reference
 *     when nothing matched so referential-equality consumers don't re-render.
 *   - `run-created`: prepend the new row — but only when `view.acceptNewRuns`
 *     (the first, otherwise-unfiltered page), only when the run's `origin`
 *     matches the active origin view (see {@link originMatchesView}), and not
 *     already present (dedupe by id, so a create that races the SSR seed
 *     doesn't double-insert).
 */
export function applyProjectFeedEvent(
  rows: readonly RunListRowData[],
  event: ProjectFeedEvent,
  view: ProjectFeedView,
): readonly RunListRowData[] {
  if (event.type === "run-progress") {
    const i = rows.findIndex((r) => r.id === event.runId);
    if (i === -1) return rows;
    const next = [...rows];
    next[i] = { ...next[i], ...event.summary };
    return next;
  }
  if (event.type === "run-created") {
    if (!view.acceptNewRuns) return rows;
    if (!originMatchesView(event.run.origin, view.origin)) return rows;
    if (rows.some((r) => r.id === event.run.id)) return rows;
    return [event.run, ...rows];
  }
  return rows;
}
