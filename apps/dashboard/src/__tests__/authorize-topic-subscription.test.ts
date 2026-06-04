import { describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeTopicSubscription,
  type RunMembershipLookup,
} from "@/lib/authz";

/**
 * `authorizeTopicSubscription` is the single tenant-isolation gate for the
 * `void/live` realtime stream — the one isolation check NOT routed through a
 * branded `AuthorizedProjectId`, because the stream handshake hands us a raw
 * topic string. It was previously an inline closure inside `defineLiveStream`,
 * runnable only inside a real handshake against real D1; extracting it (with an
 * injected `RunMembershipLookup`) makes the DECISION testable here:
 *
 *   - the topic regex (does `run:`, `run:a:b`, or a non-run topic get rejected?)
 *   - the no-user 403
 *   - the empty-rows 403 (the cross-team denial — a logged-in member of team A
 *     must not subscribe to team B's run stream)
 *
 * The lookup is faked so no `void/live` handshake and no real D1 are needed.
 */

/** A lookup that grants membership only for the given (runId → userId) pair. */
function lookupFor(authorized: Record<string, string>): RunMembershipLookup {
  return (runId, userId) => Promise.resolve(authorized[runId] === userId);
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
});
