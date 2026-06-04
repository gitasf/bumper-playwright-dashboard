// Type surface for the JSDoc-typed `probe-status.mjs` seam. The `scripts/`
// tree is `.mjs` glue (outside the typechecked `src` program), so this
// hand-written declaration lets the `src/__tests__` test import the
// readiness classifier with real types instead of an implicit `any`.

/** The dashboard-readiness verdict for an authed-probe HTTP status. */
export type ProbeStatus = "ready" | "auth-rejected" | "not-ready";

export function classifyProbe(status: number | null): ProbeStatus;
