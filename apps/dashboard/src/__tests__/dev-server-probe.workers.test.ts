import { describe, expect, it } from "vitest";
// classifyProbe is the pure readiness-contract classifier behind
// lib/dev-server.mjs's probe. It is the single source of truth for what the
// empty-body `POST /api/runs` probe status means, now shared by both the
// setup:local seed flow and the upload-fixtures e2e flow (which previously
// inlined a verbatim copy of the 400/401 convention). It lives in a
// side-effect-free module (lib/dev-server.mjs itself does module-level
// `fileURLToPath` for process spawning, which can't load under vitest's
// runner). The HTTP-bound probeDashboard / ensureDashboardRunning
// orchestration spawns processes and hits the network, so only the
// classifier is unit-tested here.
import { classifyProbe } from "../../scripts/lib/probe-status.mjs";

describe("classifyProbe", () => {
  it("treats 400 as ready (server up, auth accepted, empty body rejected)", () => {
    expect(classifyProbe(400)).toBe("ready");
  });

  it("treats 401 as auth-rejected (bad API key)", () => {
    expect(classifyProbe(401)).toBe("auth-rejected");
  });

  it("treats a network failure (null) as not-ready", () => {
    expect(classifyProbe(null)).toBe("not-ready");
  });

  it("treats any other status as not-ready (not our server / still booting)", () => {
    for (const status of [200, 204, 301, 404, 409, 500, 502, 503]) {
      expect(classifyProbe(status)).toBe("not-ready");
    }
  });
});
