import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MONITOR_PLAN,
  resolveMonitorPlan,
  sandboxSleepAfter,
} from "@/lib/monitors/sandbox-policy";

/**
 * The per-plan container idle-timeout policy. `sleepAfter` only bounds a LEAKED
 * container's idle billing (a healthy run is destroyed in the executor's
 * `finally`), so the policy pins that the default is comfortably tighter than
 * the Sandbox SDK's 10-minute default — that gap is the whole cost win — while
 * staying well above the 1s busy-poll that keeps a live `exec` alive.
 */
describe("sandboxSleepAfter", () => {
  it("resolves the default plan to a tight idle timeout (≪ the SDK's 10m default)", () => {
    expect(sandboxSleepAfter("default")).toBe("60s");
  });
});

describe("resolveMonitorPlan", () => {
  it("resolves every monitor to the default plan until a billing model exists", () => {
    expect(resolveMonitorPlan({ teamId: "team-1" })).toBe(DEFAULT_MONITOR_PLAN);
    expect(resolveMonitorPlan({ teamId: "team-2" })).toBe("default");
  });
});
