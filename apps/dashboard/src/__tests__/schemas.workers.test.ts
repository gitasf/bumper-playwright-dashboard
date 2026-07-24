import { describe, it, expect } from "vite-plus/test";
import {
  AppendResultsPayloadSchema,
  CompleteRunPayloadSchema,
  OpenRunPayloadSchema,
  RegisterArtifactsPayloadSchema,
} from "@/lib/schemas";

const validTestResult = {
  clientKey: "ck-abc-0",
  testId: "a1b2c3d4e5f67890",
  title: "Payment flow > checkout",
  file: "tests/payment.spec.ts",
  projectName: "chromium",
  status: "passed",
  durationMs: 1234,
  retryCount: 0,
  errorMessage: null,
  errorStack: null,
  workerIndex: 0,
  tags: ["@smoke"],
  annotations: [{ type: "issue", description: "GH-123" }],
  attempts: [
    {
      attempt: 0,
      status: "passed",
      durationMs: 1234,
      errorMessage: null,
      errorStack: null,
    },
  ],
};

describe("ingest payload bounds", () => {
  const wrap = (overrides: Record<string, unknown>) => ({
    results: [{ ...validTestResult, ...overrides }],
  });

  it("accepts a large (20KB) error message + stack — must not drop the batch", () => {
    // A Playwright assertion diff on a big object routinely runs to tens of KB.
    // Rejecting would fail the whole batch with a non-retryable 4xx.
    const big = "x".repeat(20_000);
    const r = AppendResultsPayloadSchema.safeParse(
      wrap({ errorMessage: big, errorStack: big }),
    );
    expect(r.success).toBe(true);
  });

  it("truncates an oversized error message instead of rejecting", () => {
    const huge = "y".repeat(200_000);
    const r = AppendResultsPayloadSchema.safeParse(
      wrap({ errorMessage: huge }),
    );
    expect(r.success).toBe(true);
    // Stored value is capped but the result is preserved, not dropped.
    if (r.success) {
      expect(r.data.results[0].errorMessage?.length).toBe(65536);
    }
  });

  it("rejects an over-long structural field (title)", () => {
    const r = AppendResultsPayloadSchema.safeParse(
      wrap({ title: "t".repeat(5000) }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects more attempts than the per-result cap", () => {
    const attempts = Array.from({ length: 101 }, (_, i) => ({
      attempt: i,
      status: "passed",
      durationMs: 1,
    }));
    const r = AppendResultsPayloadSchema.safeParse(wrap({ attempts }));
    expect(r.success).toBe(false);
  });

  it("rejects duplicate attempt indices within one result (avoids the retried 500)", () => {
    const attempts = [
      { attempt: 0, status: "passed", durationMs: 1 },
      { attempt: 0, status: "failed", durationMs: 2 },
    ];
    const r = AppendResultsPayloadSchema.safeParse(wrap({ attempts }));
    expect(r.success).toBe(false);
  });

  it("accepts distinct attempt indices", () => {
    const attempts = [
      { attempt: 0, status: "failed", durationMs: 1 },
      { attempt: 1, status: "passed", durationMs: 2 },
    ];
    const r = AppendResultsPayloadSchema.safeParse(wrap({ attempts }));
    expect(r.success).toBe(true);
  });
});

describe("ShardSchema range validation", () => {
  const openWith = (shard: unknown) =>
    OpenRunPayloadSchema.safeParse({
      idempotencyKey: "run-key",
      run: { plannedTests: [] },
      shard,
    });

  it("accepts a shard index within 1..total", () => {
    expect(openWith({ index: 2, total: 4 }).success).toBe(true);
    expect(openWith({ index: 4, total: 4 }).success).toBe(true);
  });

  it("rejects a shard index greater than total (bogus index can't satisfy the finalize count early)", () => {
    expect(openWith({ index: 7, total: 4 }).success).toBe(false);
  });

  it("rejects an out-of-range shard on /complete too", () => {
    const r = CompleteRunPayloadSchema.safeParse({
      status: "passed",
      durationMs: 10,
      shard: { index: 5, total: 3 },
    });
    expect(r.success).toBe(false);
  });
});

describe("OpenRunPayloadSchema", () => {
  const validPayload = {
    idempotencyKey: "test-key-1",
    run: {
      ciProvider: "github-actions",
      ciBuildId: "12345",
      branch: "main",
      environment: "staging",
      commitSha: "abc123",
      commitMessage: "fix things",
      prNumber: 42,
      repo: "org/repo",
      actor: "octocat",
      reporterVersion: "0.1.0",
      playwrightVersion: "1.50.0",
    },
  };

  it("accepts a valid payload", () => {
    expect(OpenRunPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it("rejects empty idempotencyKey", () => {
    const result = OpenRunPayloadSchema.safeParse({
      ...validPayload,
      idempotencyKey: "",
    });
    expect(result.success).toBe(false);
  });

  it("allows omitting every optional run field", () => {
    const result = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "key",
      run: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts null-valued metadata fields", () => {
    const result = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "key",
      run: {
        ciProvider: null,
        branch: null,
        environment: null,
        commitSha: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts plannedTests descriptors and defaults to empty array", () => {
    const withPlan = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "k",
      run: {
        plannedTests: [
          {
            testId: "abc123",
            title: "suite > test",
            file: "tests/x.spec.ts",
            projectName: "chromium",
          },
        ],
      },
    });
    expect(withPlan.success).toBe(true);
    const withoutPlan = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "k",
      run: {},
    });
    expect(withoutPlan.success).toBe(true);
    if (withoutPlan.success) {
      expect(withoutPlan.data.run.plannedTests).toEqual([]);
    }
  });

  it("rejects plannedTests entries missing required fields", () => {
    const result = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "k",
      run: {
        plannedTests: [{ testId: "", title: "t", file: "f" }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("AppendResultsPayloadSchema", () => {
  it("accepts a single valid result", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [validTestResult],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty results array (must be min 1)", () => {
    const result = AppendResultsPayloadSchema.safeParse({ results: [] });
    expect(result.success).toBe(false);
  });

  it("accepts all valid test result statuses", () => {
    for (const status of ["passed", "failed", "flaky", "skipped", "timedout"]) {
      const result = AppendResultsPayloadSchema.safeParse({
        results: [{ ...validTestResult, status }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects negative durationMs", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [{ ...validTestResult, durationMs: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults retryCount to 0", () => {
    const { retryCount: _retryCount, ...withoutRetry } = validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutRetry],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].retryCount).toBe(0);
    }
  });

  it("defaults tags to empty array", () => {
    const { tags: _tags, ...withoutTags } = validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutTags],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].tags).toEqual([]);
    }
  });

  it("defaults annotations to empty array", () => {
    const { annotations: _annotations, ...withoutAnnotations } =
      validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutAnnotations],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].annotations).toEqual([]);
    }
  });

  it("rejects empty title", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [{ ...validTestResult, title: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional clientKey", () => {
    const { clientKey: _c, ...withoutKey } = validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutKey],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty clientKey when provided", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [{ ...validTestResult, clientKey: "" }],
    });
    expect(result.success).toBe(false);
  });

  describe("attempts[]", () => {
    it("rejects missing attempts", () => {
      const { attempts: _a, ...withoutAttempts } = validTestResult;
      const result = AppendResultsPayloadSchema.safeParse({
        results: [withoutAttempts],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty attempts array", () => {
      const result = AppendResultsPayloadSchema.safeParse({
        results: [{ ...validTestResult, attempts: [] }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts multiple attempts with distinct errors", () => {
      const result = AppendResultsPayloadSchema.safeParse({
        results: [
          {
            ...validTestResult,
            status: "failed",
            retryCount: 2,
            errorMessage: "final",
            attempts: [
              {
                attempt: 0,
                status: "failed",
                durationMs: 100,
                errorMessage: "first",
                errorStack: null,
              },
              {
                attempt: 1,
                status: "failed",
                durationMs: 110,
                errorMessage: "second",
                errorStack: null,
              },
              {
                attempt: 2,
                status: "timedout",
                durationMs: 5000,
                errorMessage: "final",
                errorStack: null,
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects an invalid per-attempt status (e.g. 'flaky')", () => {
      const result = AppendResultsPayloadSchema.safeParse({
        results: [
          {
            ...validTestResult,
            attempts: [
              {
                attempt: 0,
                status: "flaky",
                durationMs: 10,
                errorMessage: null,
                errorStack: null,
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative attempt index", () => {
      const result = AppendResultsPayloadSchema.safeParse({
        results: [
          {
            ...validTestResult,
            attempts: [
              {
                attempt: -1,
                status: "passed",
                durationMs: 1,
                errorMessage: null,
                errorStack: null,
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("CompleteRunPayloadSchema", () => {
  it("accepts terminal statuses", () => {
    for (const status of ["passed", "failed", "timedout", "interrupted"]) {
      const result = CompleteRunPayloadSchema.safeParse({
        status,
        durationMs: 1000,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects 'running' (non-terminal)", () => {
    const result = CompleteRunPayloadSchema.safeParse({
      status: "running",
      durationMs: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative durationMs", () => {
    const result = CompleteRunPayloadSchema.safeParse({
      status: "passed",
      durationMs: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("RegisterArtifactsPayloadSchema", () => {
  const validPayload = {
    runId: "run-123",
    artifacts: [
      {
        testResultId: "tr-1",
        type: "trace",
        name: "trace.zip",
        contentType: "application/zip",
        sizeBytes: 1048576,
      },
    ],
  };

  it("accepts a valid payload", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts all artifact types", () => {
    for (const type of ["trace", "screenshot", "video", "other"]) {
      const result = RegisterArtifactsPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [{ ...validPayload.artifacts[0], type }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid artifact type", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], type: "pdf" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty artifacts array", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      runId: "run-123",
      artifacts: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty runId", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      runId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative sizeBytes", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], sizeBytes: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults attempt to 0 when omitted", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifacts[0].attempt).toBe(0);
    }
  });

  it("accepts attempt >= 0", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], attempt: 2 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifacts[0].attempt).toBe(2);
    }
  });

  it("rejects negative attempt", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], attempt: -1 }],
    });
    expect(result.success).toBe(false);
  });

  describe("trace replay policy", () => {
    it("accepts both canonical trace names and ZIP content types", () => {
      for (const name of ["trace", "trace.zip"]) {
        for (const contentType of [
          "application/zip",
          "application/x-zip-compressed",
        ]) {
          const result = RegisterArtifactsPayloadSchema.safeParse({
            ...validPayload,
            artifacts: [{ ...validPayload.artifacts[0], name, contentType }],
          });
          expect(result.success).toBe(true);
        }
      }
    });

    it("downgrades legacy trace claims with non-ZIP content", () => {
      for (const contentType of [
        "text/plain",
        "image/png",
        "application/octet-stream",
      ]) {
        const result = RegisterArtifactsPayloadSchema.safeParse({
          ...validPayload,
          artifacts: [{ ...validPayload.artifacts[0], contentType }],
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.artifacts[0].type).toBe("other");
      }
    });

    it("downgrades a trace claim with a non-canonical name", () => {
      const result = RegisterArtifactsPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [{ ...validPayload.artifacts[0], name: "diagnostics.zip" }],
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.artifacts[0].type).toBe("other");
    });

    it("keeps the rest of a legacy v3 batch when one trace claim is downgraded", () => {
      const result = RegisterArtifactsPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [
          {
            ...validPayload.artifacts[0],
            name: "trace",
            contentType: "text/plain",
          },
          {
            ...validPayload.artifacts[0],
            name: "screenshot.png",
            type: "screenshot",
            contentType: "image/png",
          },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.artifacts.map((artifact) => artifact.type)).toEqual([
          "other",
          "screenshot",
        ]);
      }
    });
  });

  describe("contentType allowlist", () => {
    it("rejects text/html (XSS vector when echoed back on download)", () => {
      const result = RegisterArtifactsPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [
          {
            ...validPayload.artifacts[0],
            type: "other",
            contentType: "text/html",
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects image/svg+xml (can carry inline <script>)", () => {
      const result = RegisterArtifactsPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [
          {
            ...validPayload.artifacts[0],
            type: "other",
            contentType: "image/svg+xml",
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects script content types", () => {
      for (const ct of [
        "application/javascript",
        "text/javascript",
        "application/xhtml+xml",
      ]) {
        const result = RegisterArtifactsPayloadSchema.safeParse({
          ...validPayload,
          artifacts: [
            { ...validPayload.artifacts[0], type: "other", contentType: ct },
          ],
        });
        expect(result.success).toBe(false);
      }
    });

    it("accepts every content type the Playwright reporter actually emits", () => {
      for (const ct of [
        "application/zip",
        "image/png",
        "image/jpeg",
        "video/webm",
        "video/mp4",
        "text/plain",
        "application/json",
      ]) {
        const result = RegisterArtifactsPayloadSchema.safeParse({
          ...validPayload,
          artifacts: [
            { ...validPayload.artifacts[0], type: "other", contentType: ct },
          ],
        });
        expect(result.success).toBe(true);
      }
    });
  });
});
