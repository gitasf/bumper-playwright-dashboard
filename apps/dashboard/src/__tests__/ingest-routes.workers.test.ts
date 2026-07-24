import { describe, it, expect } from "vite-plus/test";
import {
  isIngestRoute,
  isMcpRoute,
  isQueryApiRoute,
  isTenantApiRoute,
} from "@/lib/ingest-routes";

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
  // The MCP endpoint is part of the SAME Bearer-only surface (see the
  // predicate's docstring): key auth without version negotiation, throttled
  // under QUERY_RATE_LIMITER.
  "/api/mcp",
  "/api/mcp/",
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
    expect(isQueryApiRoute("/api/mcpx")).toBe(false);
    expect(isQueryApiRoute("/x/api/mcp")).toBe(false);
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

/**
 * `isMcpRoute` selects the dual-credential branch (API key OR OAuth token +
 * WWW-Authenticate on 401) inside 02.api-auth. It must be a strict SUBSET of
 * `isQueryApiRoute`: an MCP path that stopped classifying as query would fall
 * out of the QUERY_RATE_LIMITER gate in 03.
 */
describe("isMcpRoute", () => {
  it("matches only the MCP endpoint", () => {
    expect(isMcpRoute("/api/mcp")).toBe(true);
    expect(isMcpRoute("/api/mcp/")).toBe(true);
    expect(isMcpRoute("/api/v1/runs")).toBe(false);
    expect(isMcpRoute("/api/mcpx")).toBe(false);
    expect(isMcpRoute("/x/api/mcp")).toBe(false);
  });

  it("is a subset of the query surface", () => {
    for (const p of ["/api/mcp", "/api/mcp/"]) {
      expect(isQueryApiRoute(p)).toBe(true);
    }
  });
});

const TENANT_API_PATHS = [
  "/api/t/acme/p/web",
  "/api/t/acme/p/web/export/runs",
  "/api/t/acme/p/web/search",
  "/api/t/acme/p/web/quarantine",
  "/api/t/acme/p/web/runs/run_1/summary",
  "/api/t/acme/p/web/runs/run_1/tests/tr_1/replay",
];

describe("isTenantApiRoute", () => {
  it("matches the session tenant API family, including the CSV export", () => {
    for (const p of TENANT_API_PATHS) expect(isTenantApiRoute(p)).toBe(true);
  });

  it("does NOT match other API surfaces or page routes, and anchors at start", () => {
    expect(isTenantApiRoute("/api/t/acme")).toBe(false);
    expect(isTenantApiRoute("/api/t/acme/p")).toBe(false);
    expect(isTenantApiRoute("/api/teams/acme/members")).toBe(false);
    expect(isTenantApiRoute("/api/v1/runs")).toBe(false);
    expect(isTenantApiRoute("/api/runs")).toBe(false);
    expect(isTenantApiRoute("/api/auth/sign-in")).toBe(false);
    expect(isTenantApiRoute("/t/acme/p/web")).toBe(false);
    expect(isTenantApiRoute("/x/api/t/acme/p/web")).toBe(false);
  });

  it("is disjoint from both Bearer-authenticated surfaces", () => {
    for (const p of TENANT_API_PATHS) {
      expect(isIngestRoute(p)).toBe(false);
      expect(isQueryApiRoute(p)).toBe(false);
    }
    for (const p of [...QUERY_PATHS, ...INGEST_PATHS]) {
      expect(isTenantApiRoute(p)).toBe(false);
    }
  });
});
