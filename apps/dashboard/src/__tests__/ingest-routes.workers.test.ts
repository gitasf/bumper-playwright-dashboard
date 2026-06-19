import { describe, it, expect } from "vite-plus/test";
import { isIngestRoute, isQueryApiRoute } from "@/lib/ingest-routes";

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

/**
 * `isQueryApiRoute` is the source-of-truth predicate for the PUBLIC query/export
 * surface (`/api/v1/*`, roadmap 2.5), shared by the same two middleware. It must
 * be DISJOINT from `isIngestRoute`: 02.api-auth runs version negotiation for
 * ingest but NOT for query, so a path matching both classes would inherit the
 * wrong gate. These pin the match set and the disjointness.
 */
const QUERY_PATHS = [
  "/api/v1/runs",
  "/api/v1/runs/",
  "/api/v1/runs/01J",
  "/api/v1/runs/01J/tests",
  "/api/v1",
];

const INGEST_PATHS = [
  "/api/runs",
  "/api/runs/01J/results",
  "/api/runs/01J/complete",
  "/api/artifacts/register",
  "/api/artifacts/01J/upload",
];

describe("isQueryApiRoute", () => {
  it("matches every /api/v1/* path", () => {
    for (const p of QUERY_PATHS) expect(isQueryApiRoute(p)).toBe(true);
  });

  it("does NOT match ingest routes", () => {
    for (const p of INGEST_PATHS) expect(isQueryApiRoute(p)).toBe(false);
  });

  it("does NOT match unrelated /api/* or page routes, and anchors at start", () => {
    expect(isQueryApiRoute("/api/auth/sign-in")).toBe(false);
    expect(isQueryApiRoute("/api/artifacts/01J/download")).toBe(false);
    expect(isQueryApiRoute("/api/t/acme/p/web/runs/run_1/summary")).toBe(false);
    expect(isQueryApiRoute("/api/t/acme/p/web/export/runs")).toBe(false);
    // A future version must NOT match v1, and no loose prefix match.
    expect(isQueryApiRoute("/api/v2/runs")).toBe(false);
    expect(isQueryApiRoute("/api/v1x/runs")).toBe(false);
    expect(isQueryApiRoute("/x/api/v1/runs")).toBe(false);
    expect(isQueryApiRoute("/")).toBe(false);
  });
});

describe("ingest and query route classes are disjoint", () => {
  it("no path is classified as BOTH ingest and query", () => {
    for (const p of [...QUERY_PATHS, ...INGEST_PATHS]) {
      expect(isIngestRoute(p) && isQueryApiRoute(p)).toBe(false);
    }
  });
});
