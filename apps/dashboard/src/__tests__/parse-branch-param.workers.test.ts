import { describe, expect, it } from "vitest";
import {
  ALL_BRANCHES,
  parseBranchParam,
} from "@/components/run/history-branch-filter.shared";

describe("parseBranchParam", () => {
  it("returns null for the ALL_BRANCHES sentinel", () => {
    expect(parseBranchParam(ALL_BRANCHES)).toBeNull();
  });

  it("returns null for a missing param (null)", () => {
    expect(parseBranchParam(null)).toBeNull();
  });

  it("returns null for an undefined param", () => {
    expect(parseBranchParam(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseBranchParam("")).toBeNull();
  });

  it("returns the branch name unchanged for a real branch", () => {
    expect(parseBranchParam("main")).toBe("main");
    expect(parseBranchParam("feature/x")).toBe("feature/x");
  });

  it("does not treat a branch literally named like the sentinel-prefix as all", () => {
    // Only the exact sentinel decodes to null; near-misses are real branches.
    expect(parseBranchParam("__all__-2")).toBe("__all__-2");
    expect(parseBranchParam("all")).toBe("all");
  });
});
