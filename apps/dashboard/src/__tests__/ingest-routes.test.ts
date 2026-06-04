import { describe, it, expect } from "vite-plus/test";
import { isIngestRoute } from "@/lib/ingest-routes";

/**
 * `isIngestRoute` is the single source of truth shared by the Bearer gate
 * (`middleware/02.api-auth.ts`) and the throttle gate (`middleware/03.rate-limit.ts`).
 * If the covered route set ever drifts, these assertions are where it surfaces —
 * and because both middleware consume this one predicate, they cannot drift apart.
 */
describe("isIngestRoute", () => {
  it("matches the five bearer-authenticated ingest routes", () => {
    expect(isIngestRoute("/api/runs")).toBe(true);
    expect(isIngestRoute("/api/runs/01J/results")).toBe(true);
    expect(isIngestRoute("/api/runs/01J/complete")).toBe(true);
    expect(isIngestRoute("/api/artifacts/register")).toBe(true);
    expect(isIngestRoute("/api/artifacts/01J/upload")).toBe(true);
  });

  it("does NOT match the artifact download route (signed-token, not bearer)", () => {
    expect(isIngestRoute("/api/artifacts/01J/download")).toBe(false);
  });

  it("does NOT match auth or session-authed API surfaces", () => {
    expect(isIngestRoute("/api/auth/sign-in")).toBe(false);
    expect(isIngestRoute("/api/invites/abc")).toBe(false);
    expect(isIngestRoute("/api/user/me")).toBe(false);
    expect(isIngestRoute("/api/t/team/p/proj")).toBe(false);
  });

  it("does NOT match dashboard / page paths", () => {
    expect(isIngestRoute("/t/team/p/proj")).toBe(false);
    expect(isIngestRoute("/")).toBe(false);
    expect(isIngestRoute("/settings")).toBe(false);
  });

  it("anchors at the path start (no substring or prefix false positives)", () => {
    expect(isIngestRoute("/x/api/runs")).toBe(false);
    expect(isIngestRoute("/api/runscapes")).toBe(false);
    expect(isIngestRoute("/api/artifacts/register-thing")).toBe(false);
    expect(isIngestRoute("/api/artifacts")).toBe(false);
    expect(isIngestRoute("/api/artifacts/01J")).toBe(false);
  });
});
