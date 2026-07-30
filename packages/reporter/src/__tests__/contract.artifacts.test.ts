import { describe, expect, it } from "vite-plus/test";
import {
  isSafeContentType,
  SAFE_CONTENT_TYPES as DASHBOARD_SAFE_CONTENT_TYPES,
} from "../../../../apps/dashboard/src/lib/content-types.js";
import {
  isReplayTraceArtifact,
  REPLAY_TRACE_ARTIFACT_NAMES as DASHBOARD_REPLAY_TRACE_ARTIFACT_NAMES,
  REPLAY_TRACE_CONTENT_TYPES as DASHBOARD_REPLAY_TRACE_CONTENT_TYPES,
} from "../../../../apps/dashboard/src/lib/artifacts/trace.js";
import {
  isReplayTraceAttachment,
  normalizeContentType,
  REPLAY_TRACE_ARTIFACT_NAMES as REPORTER_REPLAY_TRACE_ARTIFACT_NAMES,
  REPLAY_TRACE_CONTENT_TYPES as REPORTER_REPLAY_TRACE_CONTENT_TYPES,
  SAFE_CONTENT_TYPES as REPORTER_SAFE_CONTENT_TYPES,
} from "../attachments.js";

// The reporter mirrors the dashboard's artifact content-type allowlist so a
// single attachment with an odd contentType can't 400 an entire register
// batch server-side. The mirror is a hand-maintained duplicate (the repo's
// established contract pattern); these assertions keep the two sets — and the
// reporter's normalisation — from drifting apart silently.
describe("reporter ↔ dashboard artifact content-type contract", () => {
  it("the reporter's safe-content-type mirror matches the dashboard allowlist exactly", () => {
    expect([...REPORTER_SAFE_CONTENT_TYPES].sort()).toEqual(
      [...DASHBOARD_SAFE_CONTENT_TYPES].sort(),
    );
  });

  it("normalizeContentType maps an unsafe type to one the dashboard accepts", () => {
    const normalized = normalizeContentType("text/html");
    expect(normalized).toBe("application/octet-stream");
    expect(isSafeContentType(normalized)).toBe(true);
  });

  it("every normalised output passes the dashboard's isSafeContentType", () => {
    for (const input of [
      "image/png",
      "Image/PNG; charset=utf-8",
      "image/svg+xml",
      "text/html",
      "application/zip",
      "",
      "completely/made-up",
    ]) {
      expect(isSafeContentType(normalizeContentType(input))).toBe(true);
    }
  });

  it("normalizeContentType preserves allowlisted types (modulo case/params)", () => {
    expect(normalizeContentType("video/webm")).toBe("video/webm");
    expect(normalizeContentType("Application/JSON; charset=utf-8")).toBe(
      "application/json",
    );
  });
});

describe("reporter ↔ dashboard replay trace contract", () => {
  it("keeps the canonical trace names and ZIP content types identical", () => {
    expect(REPORTER_REPLAY_TRACE_ARTIFACT_NAMES).toEqual(
      DASHBOARD_REPLAY_TRACE_ARTIFACT_NAMES,
    );
    expect(REPORTER_REPLAY_TRACE_CONTENT_TYPES).toEqual(
      DASHBOARD_REPLAY_TRACE_CONTENT_TYPES,
    );
  });

  it("keeps replay eligibility identical across the ingest boundary", () => {
    for (const candidate of [
      { name: "trace", contentType: "application/zip" },
      { name: "trace.zip", contentType: "application/x-zip-compressed" },
      { name: "trace", contentType: "Application/ZIP; charset=binary" },
      { name: "trace", contentType: "text/plain" },
      { name: "trace.zip", contentType: "image/png" },
      { name: "diagnostics.zip", contentType: "application/zip" },
    ]) {
      expect(
        isReplayTraceAttachment(candidate.name, candidate.contentType),
      ).toBe(
        isReplayTraceArtifact({
          type: "trace",
          name: candidate.name,
          contentType: candidate.contentType,
        }),
      );
    }
  });
});
