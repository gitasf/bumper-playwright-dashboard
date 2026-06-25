import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ProjectFeedEvent, MonitorExecutionRow } from "@/realtime/events";

/**
 * `useFeedRoom` (`@/realtime/use-feed-room`) is the one path-generic
 * seed/fold/reconnect-refresh plumbing hook now shared by every `void/ws`
 * feed consumer (`useProjectRoom`, `useRunRoom`, and the monitors roster).
 * `useProjectRoom` / `useRunRoom` are covered through their own hooks in
 * `use-room-reseed.test.ts`; these tests pin the GENERIC contract directly and
 * — importantly — exercise it through the MONITORS reducer
 * (`applyMonitorFeedEvent`), the consumer whose plumbing was previously an
 * inline hand-rolled copy with no reseed/reconnect coverage. With the inline
 * copy collapsed into `useFeedRoom`, the no-replay reconciliation policy is
 * tested once and the monitors path inherits it.
 *
 * `void/ws` and `@void/react` are mocked: a fake socket records message/open
 * handlers so tests can push events and simulate reconnects without a live
 * connection.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeSocket {
  params: Record<string, string>;
  message: Set<(event: unknown) => void>;
  open: Set<() => void>;
  closed: boolean;
  on: (
    type: "message" | "open",
    cb: ((event: unknown) => void) | (() => void),
  ) => () => void;
  close: () => void;
  emit: (event: unknown) => void;
  emitOpen: () => void;
}

function makeSocket(params: Record<string, string>): FakeSocket {
  const message = new Set<(event: unknown) => void>();
  const open = new Set<() => void>();
  return {
    params,
    message,
    open,
    closed: false,
    on(type, cb) {
      if (type === "open") {
        const ocb = cb as () => void;
        open.add(ocb);
        return () => open.delete(ocb);
      }
      const mcb = cb as (event: unknown) => void;
      message.add(mcb);
      return () => message.delete(mcb);
    },
    close() {
      this.closed = true;
    },
    emit(event) {
      for (const h of [...message]) h(event);
    },
    emitOpen() {
      for (const h of [...open]) h();
    },
  };
}

const sockets: FakeSocket[] = [];
const connectSpy = vi.fn(
  (_path: string, opts: { params: Record<string, string> }) => {
    const s = makeSocket(opts.params);
    sockets.push(s);
    return s;
  },
);
vi.mock("void/ws", () => ({ connect: connectSpy }));

const refreshSpy = vi.fn(() => Promise.resolve());
// Navigation state the mocked `useNavigation` reports. Mutable so a test can
// simulate an in-flight visit ("loading") and assert the reconnect-refresh
// guard skips reconciliation mid-navigation.
let navState: "idle" | "loading" | "submitting" = "idle";
vi.mock("@void/react", () => ({
  useRouter: () => ({ refresh: refreshSpy }),
  useNavigation: () => ({ state: navState }),
}));

const { useFeedRoom } = await import("@/realtime/use-feed-room");
const { resetReconnectRefreshForTests } =
  await import("@/realtime/reconnect-refresh");
// The monitors reducer that the inline plumbing used to wrap — exercised here
// through the generic hook so the monitors path inherits coverage.
const { applyMonitorFeedEvent } =
  await import("../../pages/t/[teamSlug]/p/[projectSlug]/monitors/monitor-feed");

afterEach(() => {
  cleanup();
  refreshSpy.mockClear();
  resetReconnectRefreshForTests();
  navState = "idle";
});

/** Last socket opened for the given param value. */
function socketFor(key: string, value: string): FakeSocket {
  const s = [...sockets].reverse().find((x) => x.params[key] === value);
  if (!s) throw new Error(`no socket for ${key}=${value}`);
  return s;
}

let seq = 0;
function execution(
  overrides: Partial<MonitorExecutionRow> = {},
): MonitorExecutionRow {
  seq += 1;
  return {
    id: `exec-${seq}`,
    state: "pass",
    runId: null,
    createdAt: seq,
    durationMs: 100,
    statusCode: 200,
    ...overrides,
  };
}

/**
 * A monitor row shaped like the loader's `Props["monitors"][number]` — only the
 * fields `applyMonitorFeedEvent` reads/writes (id, name, enabled, lastStatus,
 * lastRunAt, recentExecutions, uptime, type, intervalSeconds). Built loosely
 * and asserted by id/status so the test doesn't couple to the full server type.
 */
type MonitorRow = Parameters<typeof applyMonitorFeedEvent>[0][number];
function monitor(
  id: string,
  overrides: Partial<{
    name: string;
    lastStatus: string | null;
    recentExecutions: MonitorExecutionRow[];
  }> = {},
): MonitorRow {
  return {
    id,
    name: `monitor ${id}`,
    type: "browser",
    intervalSeconds: 300,
    enabled: 1,
    lastStatus: "pass",
    lastRunAt: 1,
    recentExecutions: [],
    uptime: null,
    ...overrides,
  } as unknown as MonitorRow;
}

describe("useFeedRoom (generic seed + fold)", () => {
  it("seeds from the seed thunk and folds each event through the reducer", () => {
    const projectId = "pp-fold";
    const seedRows = [monitor("m-1")];
    const { result, unmount } = renderHook(() =>
      useFeedRoom<"/ws/project/:projectId", readonly MonitorRow[]>(
        "/ws/project/:projectId",
        { projectId },
        [projectId, seedRows],
        () => [...seedRows],
        (prev, event) => applyMonitorFeedEvent(prev, event),
      ),
    );

    // Seeded straight from the thunk before any event.
    expect(result.current[0]?.[0]?.id).toBe("m-1");

    act(() => {
      socketFor("projectId", projectId).emit({
        type: "monitor-result",
        monitorId: "m-1",
        lastStatus: "fail",
        lastRunAt: 99,
        execution: execution({ state: "fail" }),
      } satisfies ProjectFeedEvent);
    });

    // The reducer advanced the matching row's status + history strip.
    expect(result.current[0]?.[0]?.lastStatus).toBe("fail");
    expect(result.current[0]?.[0]?.recentExecutions).toHaveLength(1);
    unmount();
  });

  it("ignores events the reducer drops, returning the SAME state reference (no churn)", () => {
    const projectId = "pp-ignore";
    const seedRows = [monitor("m-1")];
    const { result, unmount } = renderHook(() =>
      useFeedRoom<"/ws/project/:projectId", readonly MonitorRow[]>(
        "/ws/project/:projectId",
        { projectId },
        [projectId, seedRows],
        () => [...seedRows],
        (prev, event) => applyMonitorFeedEvent(prev, event),
      ),
    );
    const before = result.current[0];

    // A run-* frame on the shared project room — the monitor reducer ignores it
    // (returns the same array reference, so React bails out of the re-render).
    act(() => {
      socketFor("projectId", projectId).emit({
        type: "run-progress",
        runId: "run-x",
        summary: {
          totalTests: 1,
          passed: 1,
          failed: 0,
          flaky: 0,
          skipped: 0,
          durationMs: 1,
          status: "running",
          completedAt: null,
        },
      } satisfies ProjectFeedEvent);
    });

    expect(result.current[0]).toBe(before);
    unmount();
  });
});

describe("useFeedRoom (render-time reseed)", () => {
  it("keeps folded state across a re-render with a STABLE seed identity", () => {
    const projectId = "pp-stable";
    const seedRows = [monitor("m-1")];
    const { result, rerender, unmount } = renderHook(
      (p: { rows: MonitorRow[] }) =>
        useFeedRoom<"/ws/project/:projectId", readonly MonitorRow[]>(
          "/ws/project/:projectId",
          { projectId },
          [projectId, p.rows],
          () => [...p.rows],
          (prev, event) => applyMonitorFeedEvent(prev, event),
        ),
      { initialProps: { rows: seedRows } },
    );

    act(() => {
      socketFor("projectId", projectId).emit({
        type: "monitor-result",
        monitorId: "m-1",
        lastStatus: "fail",
        lastRunAt: 99,
        execution: execution({ state: "fail" }),
      } satisfies ProjectFeedEvent);
    });
    expect(result.current[0]?.[0]?.lastStatus).toBe("fail");

    // Same references — a plain re-render must NOT clobber the folded state.
    rerender({ rows: seedRows });
    expect(result.current[0]?.[0]?.lastStatus).toBe("fail");
    unmount();
  });

  it("reseeds when the seed-dep reference changes (loader re-ran)", () => {
    const projectId = "pp-reseed";
    const first = [monitor("m-1", { lastStatus: "pass" })];
    const { result, rerender, unmount } = renderHook(
      (p: { rows: MonitorRow[] }) =>
        useFeedRoom<"/ws/project/:projectId", readonly MonitorRow[]>(
          "/ws/project/:projectId",
          { projectId },
          [projectId, p.rows],
          () => [...p.rows],
          (prev, event) => applyMonitorFeedEvent(prev, event),
        ),
      { initialProps: { rows: first } },
    );

    act(() => {
      socketFor("projectId", projectId).emit({
        type: "monitor-result",
        monitorId: "m-1",
        lastStatus: "fail",
        lastRunAt: 99,
        execution: execution({ state: "fail" }),
      } satisfies ProjectFeedEvent);
    });
    expect(result.current[0]?.[0]?.lastStatus).toBe("fail");

    // The loader re-ran — fresh reference, fresh seed; the folded state is gone.
    const fresh = [monitor("m-2", { lastStatus: "pass" })];
    rerender({ rows: fresh });
    expect(result.current[0]?.map((m) => m.id)).toEqual(["m-2"]);
    expect(result.current[0]?.[0]?.lastStatus).toBe("pass");
    unmount();
  });
});

describe("useFeedRoom (reconnect → coalesced router.refresh)", () => {
  it("does NOT refresh on the first open, refreshes once on a RE-open", () => {
    const projectId = "pp-reconnect";
    const seedRows = [monitor("m-1")];
    const { unmount } = renderHook(() =>
      useFeedRoom<"/ws/project/:projectId", readonly MonitorRow[]>(
        "/ws/project/:projectId",
        { projectId },
        [projectId, seedRows],
        () => [...seedRows],
        (prev, event) => applyMonitorFeedEvent(prev, event),
      ),
    );
    const socket = socketFor("projectId", projectId);

    act(() => {
      socket.emitOpen(); // initial open — no reconciliation
    });
    expect(refreshSpy).not.toHaveBeenCalled();

    act(() => {
      socket.emitOpen(); // reconnect — rooms have no replay, so reconcile
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does NOT refresh on a reconnect that lands mid-navigation", () => {
    // A reconnect-refresh visits window.location, but Void only writes history
    // at commit time — mid-navigation that's still the page being LEFT. So while
    // a visit is in flight ("loading"), reconciling would bounce the user back.
    navState = "loading";
    const projectId = "pp-reconnect-nav";
    const seedRows = [monitor("m-1")];
    const { unmount } = renderHook(() =>
      useFeedRoom<"/ws/project/:projectId", readonly MonitorRow[]>(
        "/ws/project/:projectId",
        { projectId },
        [projectId, seedRows],
        () => [...seedRows],
        (prev, event) => applyMonitorFeedEvent(prev, event),
      ),
    );
    const socket = socketFor("projectId", projectId);

    act(() => {
      socket.emitOpen(); // initial open
      socket.emitOpen(); // reconnect — but a navigation is in flight
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    unmount();
  });
});
