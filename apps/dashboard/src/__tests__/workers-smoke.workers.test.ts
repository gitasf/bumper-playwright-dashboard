/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

// Smoke test for the workerd lane: proves these tests execute inside the real
// workerd runtime (not Node) and that nodejs_compat is on. Server-side suites
// tagged `*.workers.test.ts` run alongside this in the same lane.
describe("workerd lane smoke", () => {
  it("runs inside the workerd runtime", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("exposes the cloudflare:test env", () => {
    expect(env).toBeDefined();
  });

  it("has nodejs_compat (node:crypto resolves)", async () => {
    const { randomUUID } = await import("node:crypto");
    expect(typeof randomUUID()).toBe("string");
  });
});
