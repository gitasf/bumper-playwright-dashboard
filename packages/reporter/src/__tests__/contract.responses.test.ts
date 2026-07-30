import { describe, expect, it } from "vite-plus/test";
import {
  AppendResultsResponseSchema,
  OpenRunResponseSchema,
  QuarantineResponseSchema,
  RegisterArtifactsResponseSchema,
} from "../../../../apps/dashboard/src/lib/schemas.js";
import type {
  AppendResultsResponse,
  OpenRunResponse,
  QuarantineResponse,
  RegisterArtifactsResponse,
} from "../types.js";

// The response side (server → reporter) is the other half of the wire
// contract: the reporter reads `runId`/`runUrl`, the `clientKey → testResultId`
// mapping, and the artifact uploads off these JSON bodies (see client.ts). The
// fields are typed as the reporter's `*Response` interfaces here, so a
// reporter-side rename is a compile error; the values are then parsed through
// the dashboard's `*ResponseSchema`, so a dashboard-side rename is a runtime
// failure. This mirrors the request-side canary for the previously-unguarded
// response shapes.
describe("dashboard ↔ reporter response contract", () => {
  it("POST /api/runs response parses through OpenRunResponseSchema", () => {
    // Shape returned by routes/api/runs/index.ts.
    const response: OpenRunResponse = {
      runId: "run_abc",
      runUrl: "/t/acme/p/web/runs/run_abc",
    };
    const parsed = OpenRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("OpenRunResponseSchema tolerates the handler's extra `duplicate` field", () => {
    // The idempotent-replay path adds `duplicate: true`; the reporter ignores
    // it. Passthrough keeps it from being flagged as drift.
    const parsed = OpenRunResponseSchema.safeParse({
      runId: "run_abc",
      runUrl: "/t/acme/p/web/runs/run_abc",
      duplicate: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("OpenRunResponseSchema accepts a missing runUrl (reporter treats it as null)", () => {
    const parsed = OpenRunResponseSchema.safeParse({ runId: "run_abc" });
    expect(parsed.success).toBe(true);
  });

  it("OpenRunResponseSchema rejects a missing runId (the field the reporter requires)", () => {
    const parsed = OpenRunResponseSchema.safeParse({
      runUrl: "/t/acme/p/web/runs/run_abc",
    });
    expect(parsed.success).toBe(false);
  });

  it("POST /api/runs/:id/results response parses through AppendResultsResponseSchema", () => {
    // Shape returned by routes/api/runs/[id]/results.ts ({ results: mapping }).
    const response: AppendResultsResponse = {
      results: [
        { clientKey: "ck_1", testResultId: "tr_1" },
        { clientKey: "ck_2", testResultId: "tr_2" },
      ],
    };
    const parsed = AppendResultsResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    // The reporter keys artifact uploads off this exact pair — guard the names.
    expect(parsed.success && parsed.data.results[0]).toEqual({
      clientKey: "ck_1",
      testResultId: "tr_1",
    });
  });

  it("AppendResultsResponseSchema accepts an empty mapping (no client-keyed results)", () => {
    const parsed = AppendResultsResponseSchema.safeParse({ results: [] });
    expect(parsed.success).toBe(true);
  });

  it("AppendResultsResponseSchema rejects a mapping with a renamed key (catches drift)", () => {
    const parsed = AppendResultsResponseSchema.safeParse({
      results: [{ clientKey: "ck_1", testResultIdentifier: "tr_1" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("POST /api/artifacts/register response parses through RegisterArtifactsResponseSchema", () => {
    // Shape returned by routes/api/artifacts/register.ts ({ uploads }).
    const response: RegisterArtifactsResponse = {
      uploads: [
        {
          artifactId: "art_1",
          uploadUrl: "/api/artifacts/art_1/upload",
          r2Key: "t/team/p/proj/runs/run/tr/art_1/trace.zip",
        },
      ],
    };
    const parsed = RegisterArtifactsResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("RegisterArtifactsResponseSchema rejects an upload missing uploadUrl (the field the reporter PUTs to)", () => {
    const parsed = RegisterArtifactsResponseSchema.safeParse({
      uploads: [{ artifactId: "art_1", r2Key: "k" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("GET /api/runs/quarantine response parses through QuarantineResponseSchema", () => {
    // Shape returned by routes/api/runs/quarantine.ts ({ tests }). The reporter
    // reads `testId`/`mode`/`reason` off each entry (see quarantine.ts).
    const response: QuarantineResponse = {
      tests: [
        { testId: "t1", mode: "skip", reason: "known flaky" },
        { testId: "t2", mode: "soft", reason: null },
      ],
    };
    const parsed = QuarantineResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("QuarantineResponseSchema accepts an empty list (nothing quarantined)", () => {
    const parsed = QuarantineResponseSchema.safeParse({ tests: [] });
    expect(parsed.success).toBe(true);
  });

  it("QuarantineResponseSchema rejects an entry with an unknown mode (catches enum drift)", () => {
    const parsed = QuarantineResponseSchema.safeParse({
      tests: [{ testId: "t1", mode: "nope", reason: null }],
    });
    expect(parsed.success).toBe(false);
  });
});
