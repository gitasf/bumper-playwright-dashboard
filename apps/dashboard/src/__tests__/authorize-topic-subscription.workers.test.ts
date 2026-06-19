import { describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeTopicSubscription,
  type ProjectMembershipLookup,
  type RunMembershipLookup,
} from "@/lib/authz";

/**
 * `authorizeTopicSubscription` is the single tenant-isolation gate for the
 * `void/ws` rooms (`onBeforeConnect`) — the one isolation check NOT routed
 * through a branded `AuthorizedProjectId`, because the room connect hands us a
 * raw topic string. Extracted from the room handlers (with an injected
 * `RunMembershipLookup`) so the DECISION is testable here without a live socket:
 *
 *   - the topic regex (does `run:`, `run:a:b`, or a non-run topic get rejected?)
 *   - the no-user 403
 *   - the empty-rows 403 (the cross-team denial — a logged-in member of team A
 *     must not subscribe to team B's run room)
 *
 * The lookup is faked so no room connect and no real D1 are needed.
 */

/** A lookup that grants membership only for the given (runId → userId) pair. */
function lookupFor(authorized: Record<string, string>): RunMembershipLookup {
  return (runId, userId) => Promise.resolve(authorized[runId] === userId);
}

/** Same, for the project topic gate (projectId → userId). */
function projectLookupFor(
  authorized: Record<string, string>,
): ProjectMembershipLookup {
  return (projectId, userId) =>
    Promise.resolve(authorized[projectId] === userId);
}

describe("authorizeTopicSubscription", () => {
  describe("anonymous / no user", () => {
    it("rejects a null userId with 403 and never runs the lookup", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription(
        null,
        "run:run_1",
        lookup,
      );
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects an empty-string userId with 403 (falsy) and skips the lookup", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription("", "run:run_1", lookup);
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("topic regex", () => {
    it("accepts a well-formed run:<runId> topic for a member", async () => {
      const result = await authorizeTopicSubscription(
        "user_a",
        "run:run_1",
        lookupFor({ run_1: "user_a" }),
      );
      expect(result).toEqual({ ok: true });
    });

    it("parses the runId out of the topic and passes it to the lookup", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      await authorizeTopicSubscription("user_a", "run:01ABCXYZ", lookup);
      expect(lookup).toHaveBeenCalledWith("01ABCXYZ", "user_a");
    });

    it("rejects a bare `run:` topic with no id and skips the lookup", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription("user_a", "run:", lookup);
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects a topic with an extra colon segment (`run:a:b`)", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription(
        "user_a",
        "run:a:b",
        lookup,
      );
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects an unknown topic type and skips the lookup", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription(
        "user_a",
        "team:team_1",
        lookup,
      );
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects the empty topic string", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription("user_a", "", lookup);
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("does not treat a topic that merely starts with `run:` but has a trailing colon as valid", async () => {
      const lookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription(
        "user_a",
        "run:run_1:",
        lookup,
      );
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("cross-team isolation (empty-rows 403)", () => {
    it("denies a member of team A subscribing to team B's run", async () => {
      // run_b belongs to team B; user_a is only a member of team A, so the
      // membership lookup returns no row → 403. This is THE isolation gate.
      const result = await authorizeTopicSubscription(
        "user_a",
        "run:run_b",
        lookupFor({ run_a: "user_a", run_b: "user_b" }),
      );
      expect(result).toEqual({ ok: false, status: 403 });
    });

    it("allows the owning team's member to subscribe to the same run", async () => {
      const result = await authorizeTopicSubscription(
        "user_b",
        "run:run_b",
        lookupFor({ run_a: "user_a", run_b: "user_b" }),
      );
      expect(result).toEqual({ ok: true });
    });

    it("denies subscription to a run that has no membership rows at all", async () => {
      const result = await authorizeTopicSubscription(
        "user_a",
        "run:ghost",
        lookupFor({}),
      );
      expect(result).toEqual({ ok: false, status: 403 });
    });
  });

  describe("project topics", () => {
    it("accepts a well-formed project:<projectId> topic for a member", async () => {
      const runLookup = vi.fn<RunMembershipLookup>(() => Promise.resolve(true));
      const result = await authorizeTopicSubscription(
        "user_a",
        "project:proj_1",
        runLookup,
        projectLookupFor({ proj_1: "user_a" }),
      );
      expect(result).toEqual({ ok: true });
      // A project topic must never consult the run lookup.
      expect(runLookup).not.toHaveBeenCalled();
    });

    it("parses the projectId and passes it to the project lookup", async () => {
      const lookup = vi.fn<ProjectMembershipLookup>(() =>
        Promise.resolve(true),
      );
      await authorizeTopicSubscription(
        "user_a",
        "project:01PROJ",
        undefined,
        lookup,
      );
      expect(lookup).toHaveBeenCalledWith("01PROJ", "user_a");
    });

    it("denies a non-member of the project's team (cross-team isolation)", async () => {
      const result = await authorizeTopicSubscription(
        "user_a",
        "project:proj_b",
        undefined,
        projectLookupFor({ proj_a: "user_a", proj_b: "user_b" }),
      );
      expect(result).toEqual({ ok: false, status: 403 });
    });

    it("rejects a bare `project:` topic and skips the lookup", async () => {
      const lookup = vi.fn<ProjectMembershipLookup>(() =>
        Promise.resolve(true),
      );
      const result = await authorizeTopicSubscription(
        "user_a",
        "project:",
        undefined,
        lookup,
      );
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects an extra colon segment (`project:a:b`)", async () => {
      const lookup = vi.fn<ProjectMembershipLookup>(() =>
        Promise.resolve(true),
      );
      const result = await authorizeTopicSubscription(
        "user_a",
        "project:a:b",
        undefined,
        lookup,
      );
      expect(result).toEqual({ ok: false, status: 403 });
      expect(lookup).not.toHaveBeenCalled();
    });
  });
});
