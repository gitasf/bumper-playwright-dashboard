import { describe, expect, it } from "vite-plus/test";
import {
  isReplayTraceArtifact,
  selectReplayTracesByAttempt,
} from "@/lib/artifacts/trace";

describe("replay trace artifact policy", () => {
  it("requires both a canonical Playwright name and ZIP content type", () => {
    expect(
      isReplayTraceArtifact({
        type: "trace",
        name: "trace",
        contentType: "application/zip",
      }),
    ).toBe(true);
    expect(
      isReplayTraceArtifact({
        type: "trace",
        name: "trace.zip",
        contentType: "application/x-zip-compressed",
      }),
    ).toBe(true);
    expect(
      isReplayTraceArtifact({
        type: "trace",
        name: "diagnostics.zip",
        contentType: "application/zip",
      }),
    ).toBe(false);
    expect(
      isReplayTraceArtifact({
        type: "other",
        name: "trace.zip",
        contentType: "application/zip",
      }),
    ).toBe(false);
    expect(
      isReplayTraceArtifact({
        type: "trace",
        name: "trace",
        contentType: "text/plain",
      }),
    ).toBe(false);
  });

  it("normalizes the ZIP content type before applying the policy", () => {
    expect(
      isReplayTraceArtifact({
        type: "trace",
        name: "trace",
        contentType: "Application/ZIP; charset=binary",
      }),
    ).toBe(true);
  });

  it("returns one trace per attempt and prefers the native attachment name", () => {
    const selected = selectReplayTracesByAttempt([
      {
        id: "generic",
        type: "trace",
        name: "bundle.zip",
        contentType: "application/zip",
        attempt: 0,
      },
      {
        id: "wrong-content",
        type: "trace",
        name: "trace",
        contentType: "text/plain",
        attempt: 0,
      },
      {
        id: "legacy-0",
        type: "trace",
        name: "trace.zip",
        contentType: "application/zip",
        attempt: 0,
      },
      {
        id: "native-1",
        type: "trace",
        name: "trace",
        contentType: "application/zip",
        attempt: 1,
      },
      {
        id: "legacy-1",
        type: "trace",
        name: "trace.zip",
        contentType: "application/zip",
        attempt: 1,
      },
      {
        id: "native-0",
        type: "trace",
        name: "trace",
        contentType: "application/zip",
        attempt: 0,
      },
    ]);

    expect(selected.map((row) => row.id)).toEqual(["native-0", "native-1"]);
  });
});
