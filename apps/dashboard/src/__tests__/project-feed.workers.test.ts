import { describe, expect, it } from "vite-plus/test";
import type { ProjectFeedEvent, RunListRowData } from "@/realtime/events";
import {
  applyProjectFeedEvent,
  type ProjectFeedView,
} from "@/realtime/project-feed";
import {
  projectRoomClientSchema,
  projectRoomServerSchema,
} from "@/realtime/events";

/**
 * `applyProjectFeedEvent` is the reducer the runs-list WS room (`useProjectRoom`)
 * uses, so it's the one place run-created/run-progress merge rules live —
 * including the CLIENT-side origin-view policy (the server broadcasts
 * `run-created` for ALL runs, synthetic included). Tested here without React or
 * a live connection.
 */

function row(over: Partial<RunListRowData> = {}): RunListRowData {
  return {
    id: "r1",
    origin: "ci",
    status: "running",
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    totalTests: 0,
    durationMs: 0,
    completedAt: null,
    createdAt: 1_700_000_000,
    branch: "main",
    prNumber: null,
    commitSha: null,
    commitMessage: null,
    environment: null,
    actor: null,
    ciProvider: null,
    repo: null,
    ...over,
  };
}

/** Default view: first unfiltered page, CI origin (the list's default). */
function view(over: Partial<ProjectFeedView> = {}): ProjectFeedView {
  return { acceptNewRuns: true, origin: "ci", ...over };
}

const summary = {
  totalTests: 5,
  passed: 4,
  failed: 1,
  flaky: 0,
  skipped: 0,
  durationMs: 500,
  status: "failed",
  completedAt: 1_700_000_500,
};

describe("applyProjectFeedEvent", () => {
  describe("run-progress", () => {
    it("overlays the summary onto the matching row in place", () => {
      const rows = [row({ id: "r1" }), row({ id: "r2", passed: 9 })];
      const event: ProjectFeedEvent = {
        type: "run-progress",
        runId: "r1",
        summary,
      };
      const next = applyProjectFeedEvent(rows, event, view());
      expect(next[0]).toMatchObject({
        id: "r1",
        passed: 4,
        failed: 1,
        status: "failed",
        completedAt: 1_700_000_500,
      });
      // Static metadata is preserved; other rows untouched.
      expect(next[0].branch).toBe("main");
      expect(next[0].origin).toBe("ci");
      expect(next[1]).toBe(rows[1]);
    });

    it("is a no-op (same array reference) when the runId isn't displayed", () => {
      // An unknown id has nowhere to land — covers a synthetic run's progress
      // reaching a CI view that never prepended its row.
      const rows = [row({ id: "r1" })];
      const next = applyProjectFeedEvent(
        rows,
        { type: "run-progress", runId: "ghost", summary },
        view(),
      );
      expect(next).toBe(rows);
    });
  });

  describe("run-created", () => {
    it("prepends a brand-new run when acceptNewRuns and origins match", () => {
      const rows = [row({ id: "r1" })];
      const created = row({ id: "r2" });
      const next = applyProjectFeedEvent(
        rows,
        { type: "run-created", run: created },
        view(),
      );
      expect(next.map((r) => r.id)).toEqual(["r2", "r1"]);
    });

    it("ignores run-created when acceptNewRuns is false (filtered/paginated view), even on a matching origin", () => {
      const rows = [row({ id: "r1" })];
      const next = applyProjectFeedEvent(
        rows,
        { type: "run-created", run: row({ id: "r2" }) },
        view({ acceptNewRuns: false }),
      );
      expect(next).toBe(rows);
    });

    it("dedupes a run-created that races the SSR seed (same id already present)", () => {
      const rows = [row({ id: "r1" })];
      const next = applyProjectFeedEvent(
        rows,
        { type: "run-created", run: row({ id: "r1", passed: 3 }) },
        view(),
      );
      expect(next).toBe(rows);
      expect(next).toHaveLength(1);
    });

    describe("origin-view policy (the server broadcasts ALL origins)", () => {
      const ciRun = row({ id: "r-ci", origin: "ci" });
      const syntheticRun = row({ id: "r-syn", origin: "synthetic" });

      it("'ci' view accepts only ci runs", () => {
        const rows = [row({ id: "r1" })];
        expect(
          applyProjectFeedEvent(
            rows,
            { type: "run-created", run: ciRun },
            view({ origin: "ci" }),
          ).map((r) => r.id),
        ).toEqual(["r-ci", "r1"]);
        expect(
          applyProjectFeedEvent(
            rows,
            { type: "run-created", run: syntheticRun },
            view({ origin: "ci" }),
          ),
        ).toBe(rows);
      });

      it("'synthetic' view accepts only synthetic runs", () => {
        const rows = [row({ id: "r1", origin: "synthetic" })];
        expect(
          applyProjectFeedEvent(
            rows,
            { type: "run-created", run: syntheticRun },
            view({ origin: "synthetic" }),
          ).map((r) => r.id),
        ).toEqual(["r-syn", "r1"]);
        expect(
          applyProjectFeedEvent(
            rows,
            { type: "run-created", run: ciRun },
            view({ origin: "synthetic" }),
          ),
        ).toBe(rows);
      });

      it("'all' view accepts both origins", () => {
        const rows = [row({ id: "r1" })];
        expect(
          applyProjectFeedEvent(
            rows,
            { type: "run-created", run: ciRun },
            view({ origin: "all" }),
          ).map((r) => r.id),
        ).toEqual(["r-ci", "r1"]);
        expect(
          applyProjectFeedEvent(
            rows,
            { type: "run-created", run: syntheticRun },
            view({ origin: "all" }),
          ).map((r) => r.id),
        ).toEqual(["r-syn", "r1"]);
      });
    });
  });
});

describe("applyProjectFeedEvent defensive fall-through", () => {
  it("returns the same array reference for an unknown event type", () => {
    const rows = [row({ id: "r1" })];
    const next = applyProjectFeedEvent(
      rows,
      { type: "nope" } as unknown as ProjectFeedEvent,
      view(),
    );
    expect(next).toBe(rows);
  });
});

describe("project room schemas (void/ws messages)", () => {
  it("accepts a run-created event", () => {
    const r = projectRoomServerSchema["~standard"].validate({
      type: "run-created",
      run: row({ id: "r9" }),
    });
    expect("issues" in r && r.issues).toBeFalsy();
  });

  it("accepts a run-progress event", () => {
    const r = projectRoomServerSchema["~standard"].validate({
      type: "run-progress",
      runId: "r9",
      summary,
    });
    expect("issues" in r && r.issues).toBeFalsy();
  });

  it("rejects an unknown event type (discriminator is validated)", () => {
    const r = projectRoomServerSchema["~standard"].validate({ type: "nope" });
    expect("issues" in r && r.issues).toBeTruthy();
  });

  it("accepts the client ping and rejects other client messages", () => {
    expect(
      "issues" in
        projectRoomClientSchema["~standard"].validate({
          type: "ping",
        }),
    ).toBe(false);
    const bad = projectRoomClientSchema["~standard"].validate({
      type: "subscribe",
    });
    expect("issues" in bad && bad.issues).toBeTruthy();
  });
});
