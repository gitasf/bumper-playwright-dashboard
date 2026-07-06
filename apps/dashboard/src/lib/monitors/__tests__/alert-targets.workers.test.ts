import { describe, expect, it } from "vite-plus/test";
import {
  buildAlertTargets,
  parseAlertTargets,
  resolveTargetUserIds,
} from "@/lib/monitors/alert-targets";

// The column is `jsonb`, so `parseAlertTargets` receives the already-parsed
// value (an object/array/null), NOT a JSON string.
describe("parseAlertTargets", () => {
  it("treats null/non-object as null (= all members)", () => {
    expect(parseAlertTargets(null)).toBeNull();
    expect(parseAlertTargets(undefined)).toBeNull();
    expect(parseAlertTargets("not an object")).toBeNull();
    expect(parseAlertTargets(42)).toBeNull();
    // an array is an object but has no users/groups → both default to []
    expect(parseAlertTargets([1, 2])).toEqual({ users: [], groups: [] });
  });

  it("normalizes a well-formed object and filters non-strings", () => {
    expect(parseAlertTargets({ users: ["u1", "u2"], groups: ["g1"] })).toEqual({
      users: ["u1", "u2"],
      groups: ["g1"],
    });
    // missing arrays default to []; non-string entries dropped
    expect(parseAlertTargets({ users: ["u1", 3, null] })).toEqual({
      users: ["u1"],
      groups: [],
    });
  });

  it("round-trips what buildAlertTargets produces (stored verbatim as jsonb)", () => {
    const t = buildAlertTargets("specific", ["u1"], ["g1", "g2"]);
    expect(parseAlertTargets(t)).toEqual(t);
  });
});

describe("buildAlertTargets", () => {
  it("returns null for the 'all members' mode", () => {
    expect(buildAlertTargets("all", ["u1"], ["g1"])).toBeNull();
    expect(buildAlertTargets("anything-not-specific", [], [])).toBeNull();
  });

  it("dedups the explicit selection for 'specific'", () => {
    expect(
      buildAlertTargets("specific", ["u1", "u1", "u2"], ["g1", "g1"]),
    ).toEqual({ users: ["u1", "u2"], groups: ["g1"] });
  });

  it("preserves an empty specific selection (nobody, not all)", () => {
    expect(buildAlertTargets("specific", [], [])).toEqual({
      users: [],
      groups: [],
    });
  });
});

describe("resolveTargetUserIds", () => {
  const members = ["u1", "u2", "u3"];

  it("null targets ⇒ all members", () => {
    expect(resolveTargetUserIds(null, members, [])).toEqual(members);
  });

  it("unions explicit users with expanded group members", () => {
    const targets = { users: ["u1"], groups: ["g1"] };
    // g1 expanded to [u2] by the caller
    expect(resolveTargetUserIds(targets, members, ["u2"]).sort()).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("intersects with live members, dropping stale ids", () => {
    const targets = { users: ["u1", "gone"], groups: [] };
    // "gone" left the team — not in members, so dropped.
    expect(resolveTargetUserIds(targets, members, ["also-gone"])).toEqual([
      "u1",
    ]);
  });

  it("an empty specific selection ⇒ nobody", () => {
    expect(
      resolveTargetUserIds({ users: [], groups: [] }, members, []),
    ).toEqual([]);
  });
});
