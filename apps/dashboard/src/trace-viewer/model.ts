import type {
  ActionTraceEventInContext,
  TraceModel,
} from "./vendor/model-util";
import {
  context,
  nextActionByStartTime,
  previousActionByEndTime,
} from "./vendor/model-util";
import type { ActionTraceEvent } from "./vendor/trace";
import { TRACE_VIEWER_SCOPE, traceViewerScopeUrl } from "./origin";

export { TRACE_VIEWER_SCOPE };

export type SnapshotTabId = "action" | "before" | "after";

export type Snapshot = {
  action: ActionTraceEvent;
  snapshotName: string;
  pageId: string;
  point?: { x: number; y: number };
};

export type SnapshotSet = {
  action?: Snapshot;
  before?: Snapshot;
  after?: Snapshot;
};

function createSnapshot(
  action: ActionTraceEvent | undefined,
  snapshotNameKey: "beforeSnapshot" | "afterSnapshot" | "inputSnapshot",
): Snapshot | undefined {
  if (!action) return undefined;
  const snapshotName = action[snapshotNameKey];
  if (!snapshotName) return undefined;
  if (!action.pageId) return undefined;
  return { action, snapshotName, pageId: action.pageId, point: action.point };
}

export function collectSnapshots(
  action: ActionTraceEventInContext | undefined,
): SnapshotSet {
  if (!action) return {};

  let before = createSnapshot(action, "beforeSnapshot");
  let after = createSnapshot(action, "afterSnapshot");

  if (!before) {
    for (
      let a = previousActionByEndTime(action);
      a;
      a = previousActionByEndTime(a)
    ) {
      if (a.endTime <= action.startTime) {
        const snapshot = createSnapshot(a, "afterSnapshot");
        if (snapshot) {
          before = snapshot;
          break;
        }
      }
    }
  }

  if (!after) {
    // Iteration is by start time, so track the latest-ending descendant.
    let latest: Snapshot | undefined;
    for (
      let a = nextActionByStartTime(action);
      a && a.startTime <= action.endTime;
      a = nextActionByStartTime(a)
    ) {
      if (
        a.endTime <= action.endTime &&
        (!latest || a.endTime >= latest.action.endTime)
      ) {
        const snapshot = createSnapshot(a, "afterSnapshot");
        if (snapshot) latest = snapshot;
      }
    }
    after = latest ?? before;
  }

  const actionSnapshot = createSnapshot(action, "inputSnapshot") ?? after;
  return {
    action: actionSnapshot
      ? { ...actionSnapshot, point: action.point }
      : undefined,
    before,
    after,
  };
}

export function snapshotIframeUrl(
  traceUrl: string,
  snapshot: Snapshot,
): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  params.set("name", snapshot.snapshotName);
  if (snapshot.point) {
    params.set("pointX", String(snapshot.point.x));
    params.set("pointY", String(snapshot.point.y));
  }
  return `${traceViewerScopeUrl()}snapshot/${snapshot.pageId}?${params.toString()}`;
}

export type SnapshotInfo = SnapshotInfoError | ResolvedSnapshotInfo;

export type SnapshotInfoError = { error: string };

export type ResolvedSnapshotInfo = {
  url: string;
  viewport: { width: number; height: number };
  timestamp?: number;
  wallTime?: number;
};

export function parseSnapshotInfo(raw: unknown): SnapshotInfo | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.error === "string") return { error: raw.error };
  if (typeof raw.url !== "string") return null;
  const viewport = raw.viewport;
  if (!isRecord(viewport)) return null;
  const { width, height } = viewport;
  if (typeof width !== "number" || typeof height !== "number") return null;
  const timestamp =
    typeof raw.timestamp === "number" ? raw.timestamp : undefined;
  const wallTime = typeof raw.wallTime === "number" ? raw.wallTime : undefined;
  return { url: raw.url, viewport: { width, height }, timestamp, wallTime };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function snapshotPopoutUrl(
  traceUrl: string,
  absoluteSnapshotUrl: string,
): string {
  const params = new URLSearchParams();
  params.set("r", absoluteSnapshotUrl);
  params.set("trace", traceUrl);
  return `${traceViewerScopeUrl()}snapshot.html?${params.toString()}`;
}

export function snapshotInfoPath(traceUrl: string, snapshot: Snapshot): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  params.set("name", snapshot.snapshotName);
  return `snapshotInfo/${snapshot.pageId}?${params.toString()}`;
}

export function sha1Path(traceUrl: string, sha1: string): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  return `sha1/${sha1}?${params.toString()}`;
}

export function sha1DownloadUrl(
  traceUrl: string,
  sha1: string,
  name: string,
  contentType: string,
): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  params.set("dn", name);
  params.set("dct", contentType);
  return `${traceViewerScopeUrl()}sha1/${sha1}?${params.toString()}`;
}

export function isRealSourceFile(file: string): boolean {
  return file.includes("/") || file.includes("\\");
}

export function actionTitle(action: ActionTraceEvent): string {
  return action.title || `${action.class}.${action.method}`;
}

export function actionParamHint(action: ActionTraceEvent): string {
  const params: Record<string, unknown> = action.params ?? {};
  if (typeof params.selector === "string") return params.selector;
  if (typeof params.url === "string") return params.url;
  if (typeof params.expression === "string") return params.expression;
  return "";
}

export function snapshotViewport(action: ActionTraceEventInContext): {
  width: number;
  height: number;
} {
  return context(action)?.options?.viewport ?? { width: 1280, height: 720 };
}

export function defaultSelectedActionId(model: TraceModel): string | undefined {
  return (model.failedAction() ?? model.actions.at(-1))?.callId;
}

export type TraceTimeRange = { start: number; end: number };

export function actionIntersectsRange(
  action: ActionTraceEvent,
  range: TraceTimeRange,
): boolean {
  return action.startTime <= range.end && action.endTime >= range.start;
}

export function timeInRange(
  time: number | undefined,
  range: TraceTimeRange,
): boolean {
  return time !== undefined && time >= range.start && time <= range.end;
}

const TRACE_VERSION_ERROR_SNIPPET = "created by a newer version of Playwright";

export function describeTraceLoadError(error: string): string {
  if (error.includes(TRACE_VERSION_ERROR_SNIPPET)) {
    return "This trace was recorded with a newer Playwright version than the dashboard's replay engine supports. Download the trace and open it in the public viewer instead.";
  }
  return error;
}
