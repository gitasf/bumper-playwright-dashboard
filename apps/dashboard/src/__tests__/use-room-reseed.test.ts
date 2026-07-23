import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { RunListRowData, RunProgressTest } from "@/realtime/events";

/**
 * Void renders page components UNKEYED across SPA navigations, so the room
 * hooks (`useRunRoom` / `useProjectRoom`) re-render in place with fresh loader
 * props when the user navigates run A → run B or changes runs-list filters.
 * These tests pin the render-time reseed (live state resets when the seed
 * identity — id + seed-prop references — changes) and the reconnect
 * reconciliation (a COALESCED `router.refresh()` after a WS re-open: rooms have
 * no replay, so the loader re-runs and the reseed folds the fresh props in —
 * one refresh per reconnect burst no matter how many leaves share the socket).
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
vi.mock("@void/react", () => ({
  useRouter: () => ({ refresh: refreshSpy }),
  // Idle so the reconnect-refresh guard (skip mid-navigation) is a no-op here —
  // these tests assert the reconcile fires on RE-open. The skip-while-navigating
  // path is covered in use-feed-room.test.ts.
  useNavigation: () => ({ state: "idle" }),
}));

const { useRunRoom } = await import("@/realtime/use-run-room");
const { useProjectRoom } = await import("@/realtime/use-project-room");
const { resetReconnectRefreshForTests } =
  await import("@/realtime/reconnect-refresh");

afterEach(() => {
  cleanup();
  refreshSpy.mockClear();
  // The refresh coalescer is module-scoped (one burst window per page); reset
  // it so each test observes its own refresh instead of the previous test's.
  resetReconnectRefreshForTests();
});

/** Last socket opened for the given param value (runId / projectId). */
function socketFor(key: string, value: string): FakeSocket {
  const s = [...sockets].reverse().find((x) => x.params[key] === value);
  if (!s) throw new Error(`no socket for ${key}=${value}`);
  return s;
}

let seq = 0;
function test(overrides: Partial<RunProgressTest> = {}): RunProgressTest {
  seq += 1;
  return {
    id: `tr-${seq}`,
    testId: `t-${seq}`,
    title: `test ${seq}`,
    file: "spec.ts",
    projectName: null,
    status: "passed",
    durationMs: 100,
    retryCount: 0,
    shardIndex: null,
    ...overrides,
  };
}

function summary(
  overrides: Partial<{
    totalTests: number;
    expectedTotalTests: number | null;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    durationMs: number;
    status: string;
    completedAt: number | null;
  }> = {},
) {
  return {
    totalTests: 1,
    expectedTotalTests: null,
    passed: 1,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 100,
    status: "running",
    completedAt: null,
    ...overrides,
  };
}

function row(
  id: string,
  overrides: Partial<RunListRowData> = {},
): RunListRowData {
  return {
    id,
    origin: "ci",
    status: "running",
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    totalTests: 0,
    expectedTotalTests: null,
    durationMs: 0,
    completedAt: null,
    createdAt: 1,
    branch: null,
    prNumber: null,
    commitSha: null,
    commitMessage: null,
    environment: null,
    actor: null,
    ciProvider: null,
    repo: null,
    ...overrides,
  };
}

describe("useRunRoom (render-time reseed)", () => {
  it("keeps live event state across re-renders with a STABLE seed identity", () => {
    const runId = "rr-stable";
    const initialTests = [test({ id: "tr-a" })];
    const { result, rerender, unmount } = renderHook(
      (p: { runId: string; initialTests: RunProgressTest[] }) =>
        useRunRoom(p.runId, { initialTests: p.initialTests }),
      { initialProps: { runId, initialTests } },
    );

    act(() => {
      socketFor("runId", runId).emit({
        type: "progress",
        changedTests: [test({ id: "tr-live" })],
        summary: summary(),
      });
    });
    expect(Object.keys(result.current.byId).sort()).toEqual([
      "tr-a",
      "tr-live",
    ]);

    // Same references — a plain re-render must NOT clobber the live state.
    rerender({ runId, initialTests });
    expect(Object.keys(result.current.byId).sort()).toEqual([
      "tr-a",
      "tr-live",
    ]);
    unmount();
  });

  it("reseeds when runId changes (run A → run B navigation)", () => {
    const initialA = [test({ id: "tr-a" })];
    const initialB = [test({ id: "tr-b" })];
    const { result, rerender, unmount } = renderHook(
      (p: { runId: string; initialTests: RunProgressTest[] }) =>
        useRunRoom(p.runId, { initialTests: p.initialTests }),
      { initialProps: { runId: "rr-nav-a", initialTests: initialA } },
    );

    act(() => {
      socketFor("runId", "rr-nav-a").emit({
        type: "progress",
        changedTests: [test({ id: "tr-live-a" })],
        summary: summary(),
      });
    });
    expect(result.current.byId["tr-live-a"]).toBeDefined();

    rerender({ runId: "rr-nav-b", initialTests: initialB });
    // Run A's rows (seed + live) are gone; state is run B's seed.
    expect(Object.keys(result.current.byId)).toEqual(["tr-b"]);
    expect(result.current.summary).toBeNull();
    unmount();
  });

  it("reseeds when the seed-prop reference changes for the SAME run (loader re-ran)", () => {
    const runId = "rr-refresh";
    const first = [test({ id: "tr-old" })];
    const { result, rerender, unmount } = renderHook(
      (p: { initialTests: RunProgressTest[] }) =>
        useRunRoom(runId, { initialTests: p.initialTests }),
      { initialProps: { initialTests: first } },
    );

    act(() => {
      socketFor("runId", runId).emit({
        type: "progress",
        changedTests: [test({ id: "tr-live" })],
        summary: summary(),
      });
    });
    expect(result.current.byId["tr-live"]).toBeDefined();

    const fresh = [test({ id: "tr-new" })];
    rerender({ initialTests: fresh });
    expect(Object.keys(result.current.byId)).toEqual(["tr-new"]);
    unmount();
  });
});

describe("useRunRoom (reconnect → coalesced router.refresh)", () => {
  it("does NOT refresh on the first open", () => {
    const runId = "rr-firstopen";
    const initialSummary = summary();
    const { unmount } = renderHook(() => useRunRoom(runId, { initialSummary }));

    act(() => {
      socketFor("runId", runId).emitOpen();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("triggers exactly ONE router.refresh per reconnect across multiple leaves sharing the room", () => {
    const runId = "rr-reconnect";
    const initialSummary = summary({ status: "running" });
    const initialTests = [test({ id: "tr-a" })];
    // The run-detail page mounts ~5 leaves (glyph, duration, tab count, tiles,
    // test list) on ONE shared room socket — a reconnect fires every leaf's
    // onReconnect, and the coalescer must collapse them to a single refresh.
    const { unmount } = renderHook(() => {
      useRunRoom(runId, { initialSummary });
      useRunRoom(runId, { initialSummary });
      useRunRoom(runId, { initialTests });
    });
    const socket = socketFor("runId", runId);

    // Initial open — no reconciliation.
    act(() => {
      socket.emitOpen();
    });
    expect(refreshSpy).not.toHaveBeenCalled();

    // Re-open after a drop — every leaf's onReconnect fires, ONE refresh runs.
    act(() => {
      socket.emitOpen();
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("coalesces a reconnect burst spanning the run AND project rooms to one refresh", () => {
    const runId = "rr-cross";
    const projectId = "pp-cross";
    const initialSummary = summary();
    const initialRows = [row("run-1")];
    const { unmount } = renderHook(() => {
      useRunRoom(runId, { initialSummary });
      useProjectRoom(projectId, initialRows, {
        acceptNewRuns: true,
        origin: "ci",
      });
    });
    const runSocket = socketFor("runId", runId);
    const projectSocket = socketFor("projectId", projectId);

    act(() => {
      runSocket.emitOpen();
      projectSocket.emitOpen();
    });
    expect(refreshSpy).not.toHaveBeenCalled();

    // Both sockets re-open in the same burst (one network drop) — the shared
    // coalescer still allows only one loader refresh.
    act(() => {
      runSocket.emitOpen();
      projectSocket.emitOpen();
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("useProjectRoom (render-time reseed + reconnect)", () => {
  it("keeps live row updates across re-renders with a STABLE seed identity", () => {
    const projectId = "pp-stable";
    const initialRows = [row("run-1")];
    const { result, rerender, unmount } = renderHook(
      (p: { rows: RunListRowData[] }) =>
        useProjectRoom(projectId, p.rows, {
          acceptNewRuns: true,
          origin: "ci",
        }),
      { initialProps: { rows: initialRows } },
    );

    act(() => {
      socketFor("projectId", projectId).emit({
        type: "run-created",
        run: row("run-2"),
      });
    });
    expect(result.current.map((r) => r.id)).toEqual(["run-2", "run-1"]);

    rerender({ rows: initialRows });
    expect(result.current.map((r) => r.id)).toEqual(["run-2", "run-1"]);
    unmount();
  });

  it("reseeds when initialRows reference changes (filter / page navigation)", () => {
    const projectId = "pp-filter";
    const firstPage = [row("run-1")];
    const { result, rerender, unmount } = renderHook(
      (p: { rows: RunListRowData[] }) =>
        useProjectRoom(projectId, p.rows, {
          acceptNewRuns: true,
          origin: "ci",
        }),
      { initialProps: { rows: firstPage } },
    );

    act(() => {
      socketFor("projectId", projectId).emit({
        type: "run-created",
        run: row("run-live"),
      });
    });
    expect(result.current.map((r) => r.id)).toEqual(["run-live", "run-1"]);

    // The loader re-ran (filter change) — fresh reference, fresh rows.
    const filtered = [row("run-9")];
    rerender({ rows: filtered });
    expect(result.current.map((r) => r.id)).toEqual(["run-9"]);
    unmount();
  });

  it("applies the active origin view to run-created (reads options fresh per event)", () => {
    const projectId = "pp-origin";
    const initialRows = [row("run-1")];
    const { result, rerender, unmount } = renderHook(
      (p: { origin: "ci" | "synthetic" | "all" }) =>
        useProjectRoom(projectId, initialRows, {
          acceptNewRuns: true,
          origin: p.origin,
        }),
      {
        initialProps: { origin: "ci" } as {
          origin: "ci" | "synthetic" | "all";
        },
      },
    );
    const socket = socketFor("projectId", projectId);

    // CI view drops a synthetic run-created…
    act(() => {
      socket.emit({
        type: "run-created",
        run: row("run-syn", { origin: "synthetic" }),
      });
    });
    expect(result.current.map((r) => r.id)).toEqual(["run-1"]);

    // …but the All view (same mounted hook, new props) accepts it.
    rerender({ origin: "all" });
    act(() => {
      socket.emit({
        type: "run-created",
        run: row("run-syn", { origin: "synthetic" }),
      });
    });
    expect(result.current.map((r) => r.id)).toEqual(["run-syn", "run-1"]);
    unmount();
  });

  it("calls router.refresh() on a WS RE-open (loader re-run feeds the reseed)", () => {
    const projectId = "pp-reconnect";
    const initialRows = [row("run-1")];
    const { unmount } = renderHook(() =>
      useProjectRoom(projectId, initialRows, {
        acceptNewRuns: true,
        origin: "ci",
      }),
    );
    const socket = socketFor("projectId", projectId);

    act(() => {
      socket.emitOpen(); // initial open — no refresh
    });
    expect(refreshSpy).not.toHaveBeenCalled();

    act(() => {
      socket.emitOpen(); // reconnect
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    unmount();
  });
});
